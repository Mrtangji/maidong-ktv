/**
 * 全库批量下载（muse.db 曲库 + 最常唱优先）
 * ============================================
 * 数据流：
 *   /data/muse.db（用户放入，与 app 同款曲库）
 *     → POST /api/v1/bulk/import 解析出按 rec_score/local_hot/hot 排序的目录
 *       （data/bulk-catalog.json，NDJSON，一行一首）
 *     → POST /api/v1/bulk/start {limit} 启动 worker：
 *         ktv_api.js 热更链路实时换新签名直链 → 下载 → music/ts/<原文件名>
 *         与 muse.db、app 的 /ts 缓存严格同名对应。
 * 进度持久化在 data/bulk-state.json，服务重启后可继续（按已存在文件跳过）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { DatabaseSync } = require('node:sqlite');

const API_JS_REMOTE =
  'https://gitee.com/yangyachao-X/maidong-ktv/raw/master/app/src/main/assets/mobile/ktv_api.js';
const DL_CONCURRENCY = Math.max(1, Math.min(6, Number(process.env.BULK_CONCURRENCY) || 2)); // 并发下载（每首要先换链，CDN 压力友好）
const STATE_SAVE_EVERY = 5;      // 每完成 n 首落盘一次进度

/** Node 版 XMLHttpRequest shim：供 ktv_api.js 的 httpGet/httpPost 使用。 */
function installXhrShim() {
  if (global.XMLHttpRequest) return;
  global.XMLHttpRequest = class {
    open(method, url) { this._method = method; this._url = url; }
    setRequestHeader() {}
    send(body) {
      const done = (r) => setTimeout(() => {
        if (r instanceof Error) { this.onerror && this.onerror(r); return; }
        this.status = r.s; this.responseText = r.b; this.onload && this.onload();
      }, 0);
      const mod = this._url.startsWith('https') ? https : http;
      const req = mod.request(this._url, {
        method: this._method,
        headers: { Accept: '*/*', 'User-Agent': 'Dalvik/2.1.0' },
        timeout: 15000,
      }, (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => done({ s: res.statusCode, b }));
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (e) => done(e));
      if (body) req.write(body);
      req.end();
    }
  };
}

class BulkDownloader {
  constructor(dataDir, bulkDir) {
    this.dataDir = dataDir;
    this.bulkDir = bulkDir;   // MV 落盘目录（部署时挂 /mv）
    this.museDbPath = path.join(dataDir, 'muse.db');
    this.catalogPath = path.join(dataDir, 'bulk-catalog.json');
    this.statePath = path.join(dataDir, 'bulk-state.json');
    this.apiJsPath = path.join(__dirname, 'vendor-ktv-api.js');
    installXhrShim();
    this.state = {
      running: false,
      total: 0, done: 0, failed: 0,
      current: '',          // 正在处理的歌
      lastError: '',
      startedAt: null,
      limit: 0,
      stopRequested: false,
      mode: 'range',        // range=按区间下载 | scan=扫库补缺
      phase: '',            // 扫库补缺的执行阶段：scan → download → 空（结束）
      verify: true,         // 扫库时是否校验已下载 ts 完整性
      scanned: 0, scanTotal: 0, have: 0, invalid: 0, removed: 0,
    };
    this._loadState();
  }

  _loadState() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      Object.assign(this.state, raw, { running: false, stopRequested: false, current: '' });
    } catch (_) {}
  }

  _saveState() {
    try { fs.writeFileSync(this.statePath, JSON.stringify(this.state)); } catch (_) {}
  }

  /** muse.db 是否可用 */
  museExists() { return fs.existsSync(this.museDbPath); }

  /** 原文件名 → 目录条目 索引（惰性构建；重新导入目录后失效重建）。 */
  _catalogIndex() {
    if (this._fileIndex) return this._fileIndex;
    this._fileIndex = new Map();
    try {
      for (const l of fs.readFileSync(this.catalogPath, 'utf8').split('\n')) {
        if (!l) continue;
        try { const it = JSON.parse(l); this._fileIndex.set(it.file, it); } catch (_) {}
      }
    } catch (_) {}
    return this._fileIndex;
  }

  /** 全部目录条目（[{file,no,title,singer}]，按最常唱排序）。 */
  catalogEntries() {
    return Array.from(this._catalogIndex().values());
  }

  /** 按 muse 编号（no）查目录条目。 */
  entryByNo(no) {
    return this.catalogEntries().find((e) => e.no === no) || null;
  }

  catalogCount() {
    try { return fs.readFileSync(this.catalogPath, 'utf8').split('\n').filter(Boolean).length; }
    catch (_) { return 0; }
  }

  /** 解析 muse.db → 按最常唱排序的目录（NDJSON）。 */
  async importCatalog() {
    if (!this.museExists()) throw new Error('未找到 muse.db（请把它放到服务器 data 目录后重试）');
    const db = new DatabaseSync(this.museDbPath, { readOnly: true });
    const rows = db.prepare(
      "SELECT s.filename, s.name, s.rec_score, s.local_hot_score, s.hot_score, " +
      "(SELECT group_concat(sg.name, ',') FROM song_singer_relations ssr " +
      "INNER JOIN singers sg ON sg.id=ssr.singer_id WHERE ssr.song_id=s.id) AS sn " +
      "FROM songs s WHERE s.deleted_at IS NULL AND s.cloud_url IS NOT NULL AND s.cloud_url != '' " +
      "AND s.filename IS NOT NULL AND s.filename != '' " +
      "ORDER BY s.rec_score DESC, s.local_hot_score DESC, s.hot_score DESC"
    );
    const tmp = this.catalogPath + '.tmp';
    const out = fs.createWriteStream(tmp);
    let n = 0;
    for (const r of rows.iterate()) {
      const musicNo = r.filename.replace(/\.ls$/i, '').replace(/\.ts$/i, '');
      const line = JSON.stringify({
        file: r.filename,
        no: musicNo,
        title: r.name || musicNo,
        singer: r.sn || '',
      });
      if (!out.write(line + '\n')) {
        await new Promise((res) => out.once('drain', res));
      }
      n++;
    }
    await new Promise((res) => out.end(res));
    fs.renameSync(tmp, this.catalogPath);
    db.close();
    this._fileIndex = null;   // 目录重建，索引失效
    return n;
  }

  /**
   * 启动批量下载（已在跑则拒绝）。
   * @param {object} opts 普通模式 {from, to} 1-based 行号区间（含两端，按最常唱排序），
   *   兼容旧参数 {limit}（等价 from=1, to=limit）；
   *   扫库补缺 {mode:'scan', verify?:bool}：全库扫描已下载文件，
   *   缺失与损坏（ts 完整性校验不过）的自动进入下载队列补齐。
   */
  start(opts = {}) {
    const n = this.catalogCount();
    if (this.state.running) return { ok: false, error: '批量下载已在进行中' };
    if (!n) return { ok: false, error: '尚未导入 muse.db 曲库（先执行导入）' };
    const scan = opts.mode === 'scan';
    const limit = Number(opts.limit) || 0;
    let from = Math.max(1, Math.floor(Number(opts.from) || (limit ? 1 : 1)));
    let to = Math.floor(Number(opts.to) || (limit || n));
    if (!Number.isFinite(from) || from < 1) from = 1;
    if (!Number.isFinite(to) || to < from) to = Math.min(from + 9999, n);
    to = Math.min(to, n);
    if (scan) { from = 1; to = n; }   // 扫库补缺永远覆盖全库
    this.state.running = true;
    this.state.stopRequested = false;
    this.state.mode = scan ? 'scan' : 'range';
    this.state.phase = scan ? 'scan' : 'download';
    this.state.verify = opts.verify !== false;
    this.state.total = to - from + 1;
    this.state.done = 0;
    this.state.failed = 0;
    this.state.lastError = '';
    this.state.startedAt = new Date().toISOString();
    this.state.from = from;
    this.state.to = to;
    this.state.limit = this.state.total;
    if (scan) {
      this.state.scanTotal = this.state.total;
      this.state.scanned = 0; this.state.have = 0; this.state.invalid = 0; this.state.removed = 0;
    }
    this._saveState();
    fs.mkdirSync(this.bulkDir, { recursive: true });
    // 后台跑，不阻塞请求
    this._run().catch((e) => {
      this.state.lastError = String(e && e.message || e);
      this.state.running = false;
      this._saveState();
    });
    return { ok: true, total: this.state.total, from, to, mode: this.state.mode };
  }

  stop() {
    if (!this.state.running) return { ok: false, error: '没有进行中的批量下载' };
    this.state.stopRequested = true;
    return { ok: true };
  }

  status() {
    return {
      muse: this.museExists(),
      catalog: this.catalogCount(),
      running: this.state.running,
      mode: this.state.mode || 'range',
      phase: this.state.phase || '',
      verify: this.state.verify !== false,
      scanned: this.state.scanned || 0,
      scanTotal: this.state.scanTotal || 0,
      have: this.state.have || 0,
      invalid: this.state.invalid || 0,
      removed: this.state.removed || 0,
      total: this.state.total,
      done: this.state.done,
      failed: this.state.failed,
      current: this.state.current,
      lastError: this.state.lastError,
      startedAt: this.state.startedAt,
      from: this.state.from || 1,
      to: this.state.to || 0,
    };
  }

  /** Windows/通用非法字符安全化 + 截断。 */
  safeName(name) {
    return String(name || '')
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .slice(0, 150) || '未知';
  }

  /** 落盘文件名候选（确定性，可复现查找）：歌手 - 歌名.ts → [编号] → [编号]b2… */
  _nameCandidates(item) {
    const base = `${this.safeName(item.singer || '未知歌手')} - ${this.safeName(item.title)}`;
    const out = [base, `${base} [${item.no}]`];
    for (let i = 2; i <= 5; i++) out.push(`${base} [${item.no}]b${i}`);
    return out;
  }

  /** 该条目已下载？返回 bulkDir 中已存在的文件名，否则 null。 */
  existingName(item) {
    for (const name of this._nameCandidates(item)) {
      if (fs.existsSync(path.join(this.bulkDir, name + '.ts'))) return name + '.ts';
    }
    return null;
  }

  /** /ts 回查：按 muse.db 原文件名找对应「歌手 - 歌名.ts」的绝对路径。 */
  findExistingByMuseFile(museFile) {
    const item = this._catalogIndex().get(museFile);
    if (!item) return null;
    for (const name of this._nameCandidates(item)) {
      const p = path.join(this.bulkDir, name + '.ts');
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  /** 下载目录中所有已存在的 .ts 文件名集合（一次 readdir，扫描比对 O(1)）。 */
  _scanDirSet() {
    const set = new Set();
    for (const f of fs.readdirSync(this.bulkDir)) {
      if (f.endsWith('.ts')) set.add(f);
    }
    return set;
  }

  /**
   * TS 完整性校验（轻量，不解析流内容）：
   *   大小 > 0 且按 188（或 M2TS 192）字节整包对齐；
   *   首包 / 尾包 / 中部抽样包的同步字节必须是 0x47。
   * 截断、0 字节、被 HTML 错误页覆盖等损坏基本都能拦住。
   */
  checkTsIntegrity(p) {
    try {
      const size = fs.statSync(p).size;
      if (size === 0) return false;
      let pkt = 0;
      if (size % 188 === 0) pkt = 188;
      else if (size % 192 === 0) pkt = 192;
      else return false;
      const fd = fs.openSync(p, 'r');
      try {
        const buf = Buffer.alloc(1);
        const syncOk = (pos) => {
          fs.readSync(fd, buf, 0, 1, pos);
          return buf[0] === 0x47;
        };
        if (!syncOk(0)) return false;
        if (!syncOk(size - pkt)) return false;
        if (size > pkt * 2 && !syncOk(Math.floor(size / 2 / pkt) * pkt)) return false;
        return true;
      } finally { fs.closeSync(fd); }
    } catch (_) { return false; }
  }

  /**
   * 扫库补缺：比对目录与下载目录，构建「缺失 + 损坏」补下队列。
   * 同时清理无用文件：不在目录候选名里的孤儿 .ts、残留 .part、损坏 .ts（直接删除）。
   * 返回 null 表示用户请求了停止。
   */
  async _buildScanQueue() {
    const from = Math.max(1, Number(this.state.from) || 1);
    const to = Math.min(this.catalogCount(), Number(this.state.to) || from);
    const entries = this.catalogEntries();
    const verify = this.state.verify !== false;

    // 目录候选名全集（用于识别下载目录里的无用文件）
    const validNames = new Set();
    for (let i = from - 1; i < to; i++) {
      const item = entries[i];
      if (item) for (const name of this._nameCandidates(item)) validNames.add(name + '.ts');
    }

    // 第一步：清理下载目录里的无用文件（孤儿 .ts / 残留 .part / 损坏 .ts 校验时删）
    let removed = 0, corruptCnt = 0;
    let dirFiles;
    try { dirFiles = fs.readdirSync(this.bulkDir); } catch (_) { dirFiles = []; }
    for (const f of dirFiles) {
      if (this.state.stopRequested) return null;
      const p = path.join(this.bulkDir, f);
      try {
        if (f.endsWith('.part')) { fs.unlinkSync(p); removed++; continue; }
        if (!f.endsWith('.ts')) continue;   // 其他文件不动
        if (!validNames.has(f)) { fs.unlinkSync(p); removed++; continue; }   // 孤儿 ts：目录里没有对应条目
        if (verify && !this.checkTsIntegrity(p)) { fs.unlinkSync(p); removed++; corruptCnt++; }   // 损坏：删除待补
      } catch (_) {}
      if ((removed % 200) === 0 && removed > 0) await new Promise((r) => setImmediate(r));
    }
    this.state.removed = removed;
    this.state.invalid = corruptCnt;

    // 第二步：构建缺失补下队列（含刚被删的损坏文件）
    const names = this._scanDirSet();
    const queue = [];
    let have = 0, scanned = 0;
    for (let i = from - 1; i < to; i++) {
      if (this.state.stopRequested) return null;
      const item = entries[i];
      if (item) {
        scanned++;
        let existing = null;
        for (const name of this._nameCandidates(item)) {
          const f = name + '.ts';
          if (names.has(f)) { existing = f; break; }
        }
        if (!existing) queue.push(item);
        else have++;
      }
      if ((scanned % 200) === 0) {
        this.state.scanned = scanned;
        this.state.have = have;
        this.state.current = `扫库中 ${scanned}/${to - from + 1}`;
        this._saveState();
        await new Promise((r) => setImmediate(r));   // 让出事件循环，不卡 HTTP 服务
      }
    }
    this.state.scanned = scanned;
    this.state.have = have;
    return queue;
  }

  async _run() {
    // 热更链路：启动时尝试拉最新 ktv_api.js（失败用本地副本）
    try {
      const fresh = await new Promise((resolve) => {
        const mod = API_JS_REMOTE.startsWith('https') ? https : http;
        const req = mod.get(API_JS_REMOTE, { timeout: 6000 }, (res) => {
          if (res.statusCode !== 200) { resolve(null); res.resume(); return; }
          let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(b));
        });
        req.on('timeout', () => req.destroy());
        req.on('error', () => resolve(null));
      });
      if (fresh && fresh.includes('KtvApi')) fs.writeFileSync(this.apiJsPath, fresh);
    } catch (_) {}

    delete require.cache[require.resolve(this.apiJsPath)];
    const { KtvApi } = require(this.apiJsPath);
    const api = new KtvApi({ debug: false });

    // 构建下载队列：扫库补缺模式全库扫描，普通模式按 [from, to] 区间
    let queue;
    if (this.state.mode === 'scan') {
      const q = await this._buildScanQueue();
      if (!q) {   // 扫描期间请求停止
        this.state.running = false;
        this.state.current = '';
        this._saveState();
        return;
      }
      queue = q;
      this.state.phase = 'download';
      this.state.total = queue.length;
      this.state.done = 0;
      this.state.failed = 0;
      this.state.limit = queue.length;
      this.state.current = '';
      this._saveState();
    } else {
      // 读取目录的 [from, to] 区间（1-based，含两端）
      const from = Math.max(1, Number(this.state.from) || 1);
      const to = Math.min(this.catalogCount(), Number(this.state.to) || from + 9999);
      const lines = fs.readFileSync(this.catalogPath, 'utf8').split('\n').filter(Boolean).slice(from - 1, to);
      queue = lines.map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    }
    let sinceSave = 0;

    const worker = async (queue) => {
      while (queue.length > 0) {
        if (this.state.stopRequested) return;
        const item = queue.shift();
        if (!item) return;
        if (this.existingName(item)) { this.state.done++; continue; } // 已下载（歌手 - 歌名.ts），秒过
        this.state.current = `${item.title}（${item.singer || '未知歌手'}）`;
        let target = null;
        try {
          const url = await api.getSongUrl(item.no, '720', false);
          if (!url) throw new Error('换链失败');
          // 落盘名：歌手 - 歌名.ts（冲突时 [编号] 系列后缀）
          for (const name of this._nameCandidates(item)) {
            const p = path.join(this.bulkDir, name + '.ts');
            if (!fs.existsSync(p)) { target = p; break; }
          }
          if (!target) { this.state.done++; continue; }
          await this._download(url, target);
          this.state.done++;
        } catch (e) {
          this.state.failed++;
          this.state.lastError = `${item.title}: ${e && e.message || e}`;
          if (target) { try { fs.unlinkSync(target + '.part'); } catch (_) {} }
        }
        if (++sinceSave >= STATE_SAVE_EVERY) { sinceSave = 0; this._saveState(); }
      }
    };

    const workers = Array.from({ length: DL_CONCURRENCY }, () => worker(queue));
    await Promise.all(workers);
    this.state.running = false;
    this.state.current = '';
    this.state.phase = '';
    this._saveState();
  }

  _download(url, target, redirectsLeft = 3) {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(target + '.part');
      const mod = url.startsWith('https') ? https : http;
      const req = mod.get(url, { timeout: 60000, headers: { Accept: '*/*' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
          res.resume();
          file.close();
          return this._download(res.headers.location, target, redirectsLeft - 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          file.close(() => fs.unlink(target + '.part', () => {}));
          return reject(new Error('HTTP ' + res.statusCode));
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => fs.rename(target + '.part', target, resolve)));
      });
      req.on('timeout', () => req.destroy(new Error('下载超时')));
      req.on('error', (e) => {
        file.close(() => fs.unlink(target + '.part', () => reject(e)));
      });
    });
  }
}

module.exports = { BulkDownloader };
