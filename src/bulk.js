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
const { execFile } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const ets = require('./ets');

const API_JS_REMOTE =
  'https://gitee.com/yangyachao-X/maidong-ktv/raw/master/app/src/main/assets/mobile/ktv_api.js';
const DL_CONCURRENCY = Math.max(1, Math.min(6, Number(process.env.BULK_CONCURRENCY) || 2)); // 并发下载（每首要先换链，CDN 压力友好）
const STATE_SAVE_EVERY = 5;      // 每完成 n 首落盘一次进度
// 单曲多线程分段下载：CDN 支持 Range（实测 4~8 路并发 206），切成 N 段并行拉再拼接。
// 任一段失败（含 CDN 瞬时 416 限速）自动回退单流下载。
const SEGMENTS = Math.max(1, Math.min(16, Number(process.env.BULK_SEGMENTS) || 6));
const SEG_MIN_SIZE = 8 * 1024 * 1024;   // 小于 8MB 的文件不多线程（单流足够快）
// 和音元反盗版占位 ts 的字节大小黑名单（这些"文件"结构合法但无法播放），可用 BULK_BLOCK_SIZES 扩展
const BLOCK_SIZES = new Set(
  (process.env.BULK_BLOCK_SIZES || '12050612')
    .split(',').map((s) => Number(s.trim())).filter((n) => n > 0)
);

/** Node 版 XMLHttpRequest shim：供 ktv_api.js 的 httpGet/httpPost 使用。 */
function installXhrShim() {
  if (global.XMLHttpRequest) return;
  global.XMLHttpRequest = class {
    open(method, url) { this._method = method; this._url = url; }
    setRequestHeader() {}
    send(body) {
      // 任何情况下都必须让回调落定：vendor 脚本可能只设置了 onload 没设置 onerror，
      // 若请求挂死（如超时后脚本不处理 onerror），await getSongUrl 会永远挂起 → 停止按钮失效。
      let settled = false;
      const done = (r) => {
        if (settled) return;
        settled = true;
        setTimeout(() => {
          if (r instanceof Error) {
            if (this.onerror) return this.onerror(r);
            // 脚本未设置 onerror：伪造 0 状态响应触发其 onload 里的错误分支
            this.status = 0; this.responseText = '';
            this.onload && this.onload();
            return;
          }
          this.status = r.s; this.responseText = r.b; this.onload && this.onload();
        }, 0);
      };
      const mod = this._url.startsWith('https') ? https : http;
      const req = mod.request(this._url, {
        method: this._method,
        headers: { Accept: '*/*', 'User-Agent': 'Dalvik/2.1.0' },
        timeout: 15000,
      }, (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => done({ s: res.statusCode, b }));
        res.on('error', (e) => done(e));
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (e) => done(e));
      // 绝对期限兜底：不管连接处于什么状态（如 CDN 慢速滴流骗过 idle timeout）都强制结束
      const killer = setTimeout(() => {
        try { req.destroy(new Error('request deadline exceeded')); } catch (_) {}
        done(new Error('换链请求超时（30s 绝对期限）'));
      }, 30000);
      if (killer.unref) killer.unref();
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
    this.antipiracyPath = path.join(dataDir, 'bulk-antipiracy.txt');   // 反盗版歌曲记录：每行 编号|歌手 - 歌名|原因
    this.failedLogPath = path.join(dataDir, 'bulk-failed.txt');        // 下载失败记录：每行 编号|歌手 - 歌名|原因
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
      mode: 'range',        // range=按区间下载 | scan=扫库补缺 | mv=编号MV补下
      phase: '',            // 扫库补缺的执行阶段：scan → download → 空（结束）
      verify: true,         // 扫库时是否校验已下载 ts 完整性
      scanned: 0, scanTotal: 0, have: 0, invalid: 0, removed: 0, stubbed: 0, etsStripped: 0,
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
    const mv = opts.mode === 'mv';
    if (mv && !this.antipiracyCount()) return { ok: false, error: '反盗版编号记录为空（先跑一次普通下载/扫库补缺）' };
    const limit = Number(opts.limit) || 0;
    let from = Math.max(1, Math.floor(Number(opts.from) || (limit ? 1 : 1)));
    let to = Math.floor(Number(opts.to) || (limit || n));
    if (!Number.isFinite(from) || from < 1) from = 1;
    if (!Number.isFinite(to) || to < from) to = Math.min(from + 9999, n);
    to = Math.min(to, n);
    if (scan || mv) { from = 1; to = n; }   // 扫库/编号补下覆盖全库
    this.state.running = true;
    this.state.stopRequested = false;
    this.state.mode = scan ? 'scan' : (mv ? 'mv' : 'range');
    this.state.phase = scan ? 'scan' : 'download';
    this.state.verify = opts.verify !== false;
    this.state.total = mv ? this.antipiracyCount() : (to - from + 1);
    this.state.done = 0;
    this.state.failed = 0;
    this.state.stubbed = 0;
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
    // 级联中断在途下载 / 规范化流
    try { if (this._abort) this._abort.abort(); } catch (_) {}
    // 看门狗兜底：万一仍有不可中断的操作（如卡死的同步 fs）挂住 worker，45s 后强制收尾
    clearTimeout(this._stopTimer);
    this._stopTimer = setTimeout(() => {
      if (this.state.running && this.state.stopRequested) {
        this.state.running = false;
        this.state.current = '';
        this._saveState();
      }
    }, 45000);
    if (this._stopTimer.unref) this._stopTimer.unref();
    return { ok: true };
  }

  status() {
    return {
      muse: this.museExists(),
      catalog: this.catalogCount(),
      running: this.state.running,
      stopping: !!(this.state.running && this.state.stopRequested),
      mode: this.state.mode || 'range',
      phase: this.state.phase || '',
      verify: this.state.verify !== false,
      scanned: this.state.scanned || 0,
      scanTotal: this.state.scanTotal || 0,
      have: this.state.have || 0,
      invalid: this.state.invalid || 0,
      removed: this.state.removed || 0,
      stubbed: this.state.stubbed || 0,
      etsStripped: this.state.etsStripped || 0,
      antipiracy: this.antipiracyCount(),
      failedLog: this._failedMap().size,
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

  // ----- 反盗版/失败记录（data/bulk-antipiracy.txt 与 data/bulk-failed.txt，每行 编号|歌手 - 歌名|原因） -----
  _antipiracyMap() {
    return this._loadNoNameReasonMap(this.antipiracyPath);
  }

  _failedMap() {
    return this._loadNoNameReasonMap(this.failedLogPath);
  }

  /** 读取「编号|友好名[|原因]」记录文件 → Map(no → {name, reason})。 */
  _loadNoNameReasonMap(p) {
    const map = new Map();
    try {
      for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
        const s = line.trim();
        if (!s) continue;
        const parts = s.split('|');
        if (parts.length >= 2 && parts[0]) {
          map.set(parts[0], { name: parts.slice(1, parts.length - (parts.length >= 3 ? 1 : 0)).join('|') || '未知', reason: parts.length >= 3 ? parts[parts.length - 1] : '' });
        }
      }
    } catch (_) {}
    return map;
  }

  _writeNoNameReasonMap(p, map) {
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, Array.from(map).map(([no, v]) => `${no}|${v.name}|${v.reason || '反盗版占位'}`).join('\n') + '\n');
    fs.renameSync(tmp, p);
  }

  antipiracyCount() { return this._antipiracyMap().size; }

  /** 记录反盗版歌曲（去重，带友好名与原因）。 */
  _recordAntipiracy(item, reason) {
    if (!item || !item.no) return;
    try {
      const map = this._antipiracyMap();
      map.set(String(item.no), {
        name: `${this.safeName(item.singer || '未知歌手')} - ${this.safeName(item.title)}`,
        reason: reason || '反盗版占位',
      });
      this._writeNoNameReasonMap(this.antipiracyPath, map);
    } catch (_) {}
  }

  /** 记录下载失败歌曲（去重，带原因）。 */
  _recordFailed(item, reason) {
    if (!item || !item.no) return;
    try {
      const map = this._failedMap();
      map.set(String(item.no), {
        name: `${this.safeName(item.singer || '未知歌手')} - ${this.safeName(item.title)}`,
        reason: String(reason || '').slice(0, 200) || '未知原因',
      });
      this._writeNoNameReasonMap(this.failedLogPath, map);
    } catch (_) {}
  }

  /** 编号补下成功后从记录中移除。 */
  _removeAntipiracy(no) {
    try {
      const map = this._antipiracyMap();
      if (map.delete(String(no))) {
        this._writeNoNameReasonMap(this.antipiracyPath, map);
      }
    } catch (_) {}
  }

  /** 补下成功后同时从失败记录中移除。 */
  _removeFailed(no) {
    try {
      const map = this._failedMap();
      if (map.delete(String(no))) {
        this._writeNoNameReasonMap(this.failedLogPath, map);
      }
    } catch (_) {}
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
   * TS 结构完整性校验（轻量，不解析流内容）：
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

  /** 反盗版占位检测：命中字节大小黑名单（如和音元 12,050,612 字节占位 ts）。 */
  isAntiPiracyStub(p) {
    try { return BLOCK_SIZES.has(fs.statSync(p).size); } catch (_) { return false; }
  }

  /** ffprobe 是否可用（探测一次并缓存；BULK_FFPROBE=0 强制关闭）。 */
  async _ffprobeAvailable() {
    if (this._ffprobeOk !== undefined) return this._ffprobeOk;
    this._ffprobeOk = await new Promise((resolve) => {
      if (process.env.BULK_FFPROBE === '0') return resolve(false);
      execFile('ffprobe', ['-version'], { timeout: 5000 }, (err) => resolve(!err));
    });
    return this._ffprobeOk;
  }

  /**
   * 成片校验（下载完成后逐首调用）：返回 null 表示通过，否则返回失败原因。
   *   1. TS 结构完整性（整包对齐 + 同步字节）
   *   2. 反盗版占位大小黑名单
   *   3. ffprobe 真解析（服务器镜像内置 ffmpeg；不可用或 BULK_FFPROBE=0 时自动跳过）
   */
  async validateSongFile(p) {
    if (!this.checkTsIntegrity(p)) return 'ts结构不完整';
    if (this.isAntiPiracyStub(p)) return `反盗版占位文件（${fs.statSync(p).size} 字节）`;
    if (await this._ffprobeAvailable()) {
      const bad = await this._ffprobeCheck(p);
      if (bad) return bad;
    }
    return null;
  }

  /**
   * ffprobe 深检（快速探测模式）：真解析文件，解不出格式/无法渲染 → 无效。
   * probesize/analyzeduration 限制探测窗口，单个文件几十毫秒级。
   */
  _ffprobeCheck(p) {
    return new Promise((resolve) => {
      execFile('ffprobe',
        ['-v', 'error', '-probesize', '4M', '-analyzeduration', '8M',
         '-show_entries', 'format=format_name', '-of', 'json', p],
        { timeout: 20000, maxBuffer: 1 << 20 },
        (err) => resolve(err ? 'ffprobe 无法解析（无法渲染）' : null));
    });
  }

  /** 扫库用轻量校验：结构完整性 + 反盗版占位（不含 ffprobe）。 */
  validateSongFileCheap(p) {
    if (!this.checkTsIntegrity(p)) return 'ts结构不完整';
    if (this.isAntiPiracyStub(p)) return `反盗版占位文件（${fs.statSync(p).size} 字节）`;
    return null;
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

    // 目录候选名全集（用于识别下载目录里的无用文件；同时保留 名→条目 反查用于占位记录）
    const validNames = new Set();
    const nameItem = new Map();
    for (let i = from - 1; i < to; i++) {
      const item = entries[i];
      if (item) for (const name of this._nameCandidates(item)) {
        validNames.add(name + '.ts');
        nameItem.set(name + '.ts', item);
      }
    }

    // 第一步：清理下载目录里的无用文件（孤儿 .ts / 残留 .part / 损坏·占位·无法渲染 .ts 校验时删）
    // 轻量校验（结构+占位）先过滤一遍，通过的再过 ffprobe 真解析，拦住「结构合法但无法渲染」的文件
    let removed = 0, corruptCnt = 0, stubCnt = 0, probed = 0;
    let dirFiles;
    try { dirFiles = fs.readdirSync(this.bulkDir); } catch (_) { dirFiles = []; }
    const probeOk = verify ? await this._ffprobeAvailable() : false;
    const PROBE_BATCH = 4;   // ffprobe 并发探测路数
    for (let i = 0; i < dirFiles.length; i += PROBE_BATCH) {
      if (this.state.stopRequested) return null;
      const chunk = dirFiles.slice(i, i + PROBE_BATCH);
      const results = await Promise.all(chunk.map(async (f) => {
        const p = path.join(this.bulkDir, f);
        try {
          if (f.endsWith('.part')) { fs.unlinkSync(p); return 'removed'; }
          if (!f.endsWith('.ts')) return null;   // 其他文件不动
          if (!validNames.has(f)) { fs.unlinkSync(p); return 'removed'; }   // 孤儿 ts：目录里没有对应条目
          if (verify) {
            let bad = this.validateSongFileCheap(p);
            if (bad) {
              // 官方 E/ts（私有头 / AES 分段加密）：规范化后重验，能救活就修复保留（不删除）
              try {
                const norm = await ets.normalizeFile(p);
                if (norm.changed) {
                  this.state.etsStripped = (this.state.etsStripped || 0) + 1;
                  bad = this.validateSongFileCheap(p);
                }
              } catch (_) {}
            }
            if (!bad && probeOk) {
              probed++;
              bad = await this._ffprobeCheck(p);   // 结构合法但解不出音视频 → 无法渲染，同样无效
            }
            if (bad) {
              fs.unlinkSync(p);
              if (bad.indexOf('反盗版') >= 0) { this._recordAntipiracy(nameItem.get(f), bad); return 'stub'; }
              return 'corrupt';
            }
          }
        } catch (_) {}
        return null;
      }));
      for (const r of results) {
        if (r === 'removed') removed++;
        else if (r === 'stub') { removed++; stubCnt++; }
        else if (r === 'corrupt') { removed++; corruptCnt++; }
      }
      if ((i / PROBE_BATCH) % 25 === 0) {
        this.state.current = `清理校验中 ${Math.min(i + PROBE_BATCH, dirFiles.length)}/${dirFiles.length}`;
        this._saveState();
        await new Promise((r) => setImmediate(r));   // 让出事件循环，不卡 HTTP 服务
      }
    }
    this.state.removed = removed;
    this.state.invalid = corruptCnt;
    this.state.probed = probed;
    if (stubCnt) this.state.stubbed = (this.state.stubbed || 0) + stubCnt;

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
    this._abort = new AbortController();   // stop() 时级联中断在途下载/流
    clearTimeout(this._stopTimer);
    let api;
    if (this.state.mode === 'mv') {
      // 编号MV补下：固定用 vendor 版 ktv_api（demo 过滤 + ls/设备轮询 + regenerateDevice），
      // 不做 gitee 热更，避免官方脚本覆盖掉 vendor 能力。
      delete require.cache[require.resolve(this.apiJsPath)];
      api = new (require(this.apiJsPath).KtvApi)({ debug: false });
    } else {
      // 普通下载：热更链路尝试拉最新 ktv_api.js（写入独立 .fresh.js，不覆盖 vendor 原件），失败用本地 vendor 副本
      const freshPath = this.apiJsPath + '.fresh.js';
      let freshOk = false;
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
        if (fresh && fresh.includes('KtvApi')) { fs.writeFileSync(freshPath, fresh); freshOk = true; }
      } catch (_) {}
      const usePath = freshOk ? freshPath : this.apiJsPath;
      delete require.cache[require.resolve(usePath)];
      api = new (require(usePath).KtvApi)({ debug: false });
    }

    // 构建下载队列：编号MV补下 / 扫库补缺 / 普通区间
    let queue;
    if (this.state.mode === 'mv') {
      // 读取反盗版记录文件（编号|友好名|原因），优先用目录条目补全元数据
      const map = this._antipiracyMap();
      queue = [];
      for (const [no, info] of map) {
        const nm = info.name || '';
        const e = this.entryByNo(no);
        if (e) { queue.push(e); continue; }
        const i = nm.indexOf(' - ');
        queue.push({
          file: no + '.ts', no,
          title: i >= 0 ? nm.slice(i + 3) : (nm || ('编号' + no)),
          singer: i >= 0 ? nm.slice(0, i) : '',
        });
      }
      queue = queue.filter((item) => !this.existingName(item));   // 已下载成功的直接剔除
      this.state.phase = 'download';
      this.state.total = queue.length;
      this.state.done = 0;
      this.state.failed = 0;
      this.state.stubbed = 0;
      this.state.limit = queue.length;
      this.state.current = '';
      this._saveState();
      if (!queue.length) {
        this.state.running = false;
        this.state.current = '';
        this._saveState();
        return;
      }
    } else if (this.state.mode === 'scan') {
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

    const isStubReason = (s) => typeof s === 'string' && s.indexOf('反盗版') >= 0;
    const maxAttempts = this.state.mode === 'mv' ? 3 : 1;   // mv 模式允许设备重生多轮重试
    const STOPPED = new Error('已停止');   // 哨兵：停止中断不算失败
    const SONG_TIMEOUT_MS = Math.max(60, Number(process.env.BULK_SONG_TIMEOUT) || 300) * 1000;   // 单曲整体超时（默认 5 分钟），超时跳过

    // 清理一首歌的所有半成品（.part 与各分段 .segN）
    const cleanupSong = (target) => {
      if (!target) return;
      try { fs.unlinkSync(target + '.part'); } catch (_) {}
      for (let i = 0; i < SEGMENTS; i++) { try { fs.unlinkSync(target + '.seg' + i); } catch (_) {} }
    };

    const worker = async (queue) => {
      while (queue.length > 0) {
        if (this.state.stopRequested) return;
        const item = queue.shift();
        if (!item) return;
        if (this.existingName(item)) { this.state.done++; continue; } // 已下载（歌手 - 歌名.ts），秒过
        this.state.current = `${item.title}（${item.singer || '未知歌手'}）`;
        let target = null;
        let stubReason = '';
        // 单曲超时看门狗：到点中断本首歌（AbortSignal 级联），跳过计失败，不再无限等
        let timedOut = false;
        const songAc = new AbortController();
        const runSignal = this._abort ? this._abort.signal : null;
        const songSignal = (runSignal && typeof AbortSignal.any === 'function')
          ? AbortSignal.any([runSignal, songAc.signal]) : songAc.signal;
        const songTimer = setTimeout(() => { timedOut = true; songAc.abort(); }, SONG_TIMEOUT_MS);
        if (songTimer.unref) songTimer.unref();
        try {
          let stubbed = false;
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const url = await api.getSongUrl(item.no, '720', false, this.state.mode === 'mv' ? '0' : undefined);
            if (this.state.stopRequested) throw STOPPED;
            if (timedOut) throw new Error(`单曲处理超时（${SONG_TIMEOUT_MS / 1000}s），已跳过`);
            if (!url) throw new Error('换链失败');
            // 反盗版 .ls 链：换设备重试或记档跳过
            if (/\.ls(\?|#|$)/i.test(url)) {
              if (attempt < maxAttempts && typeof api.regenerateDevice === 'function') {
                api.regenerateDevice();
                continue;
              }
              stubbed = true;
              stubReason = '.ls 加密占位链';
              break;
            }
            // 落盘名：歌手 - 歌名.ts（冲突时 [编号] 系列后缀）
            target = null;
            for (const name of this._nameCandidates(item)) {
              const p = path.join(this.bulkDir, name + '.ts');
              if (!fs.existsSync(p)) { target = p; break; }
            }
            if (!target) break;   // 已存在，视为完成
            await this._downloadSmart(url, target, songSignal);
            if (this.state.stopRequested) throw STOPPED;
            if (timedOut) throw new Error(`单曲处理超时（${SONG_TIMEOUT_MS / 1000}s），已跳过`);
            // 官方 E/ts（私有头 / AES 分段加密）：规范化成标准 TS，否则无法播放/转码
            try {
              const norm = await ets.normalizeFile(target, songSignal);
              if (norm.changed) this.state.etsStripped = (this.state.etsStripped || 0) + 1;
            } catch (e) {
              if (this.state.stopRequested) throw STOPPED;
              /* 规范化失败保留原样，交给成片校验判定 */
            }
            // 成片校验：不是有效歌曲 → 删除；反盗版占位 → 换设备重试或记档跳过
            const bad = await this.validateSongFile(target);
            if (this.state.stopRequested) throw STOPPED;
            if (bad) {
              try { fs.unlinkSync(target); } catch (_) {}
              if (isStubReason(bad)) {
                if (attempt < maxAttempts && typeof api.regenerateDevice === 'function') {
                  api.regenerateDevice();
                  continue;
                }
                stubbed = true;
                stubReason = bad;
                break;
              }
              throw new Error(bad);
            }
            stubbed = false;
            break;
          }
          if (stubbed) {
            // 反盗版：记档（编号|歌手 - 歌名|原因）并跳过，不计失败
            this._recordAntipiracy(item, stubReason);
            this.state.stubbed = (this.state.stubbed || 0) + 1;
            this.state.current = `跳过反盗版：${item.title}（${item.singer || '未知歌手'}）`;
          } else {
            this.state.done++;
            this._removeFailed(item.no);
            if (this.state.mode === 'mv') this._removeAntipiracy(item.no);   // 补下成功，移出记录
          }
        } catch (e) {
          if (e === STOPPED || (e && e.name === 'AbortError') || this.state.stopRequested) {
            if (this.state.stopRequested) {
              // 停止中断：清理半成品后静默退出，不计失败
              cleanupSong(target);
              clearTimeout(songTimer);
              return;
            }
            // 单曲超时的 AbortError（非停止）：按超时跳过处理
            const msg = `单曲处理超时（${SONG_TIMEOUT_MS / 1000}s），已跳过`;
            this.state.failed++;
            this.state.lastError = `${item.title}: ${msg}`;
            this._recordFailed(item, msg);
            cleanupSong(target);
          } else {
            const msg = String(e && e.message || e);
            if (isStubReason(msg)) {
              // 下载阶段拦截到的占位（如 Content-Length 命中黑名单）：同样记档跳过，不计失败
              this._recordAntipiracy(item, msg);
              this.state.stubbed = (this.state.stubbed || 0) + 1;
              this.state.current = `跳过反盗版：${item.title}（${item.singer || '未知歌手'}）`;
            } else {
              this.state.failed++;
              this.state.lastError = `${item.title}: ${msg}`;
              this._recordFailed(item, msg);   // 失败原因写入 bulk-failed.txt
              cleanupSong(target);
            }
          }
        } finally {
          clearTimeout(songTimer);
        }
        if (++sinceSave >= STATE_SAVE_EVERY) { sinceSave = 0; this._saveState(); }
      }
    };

    // mv 模式单线程：同一 api 实例的设备重生不可并发
    const workers = Array.from({ length: this.state.mode === 'mv' ? 1 : DL_CONCURRENCY }, () => worker(queue));
    await Promise.allSettled(workers);   // 单个 worker 意外死亡不拖垮整体，其余继续收尾
    clearTimeout(this._stopTimer);
    this.state.running = false;
    this.state.current = '';
    this.state.phase = '';
    this._saveState();
  }

  /**
   * 智能下载入口：先 Range 探测拿总大小，命中反盗版直接拦截（一个字节不拉）；
   * 支持 Range 且文件够大 → 多线程分段并行下载；否则/失败 → 回退单流 _download。
   */
  async _downloadSmart(url, target, signal) {
    if (SEGMENTS <= 1) return this._download(url, target, 3, signal);
    const probe = await new Promise((resolve) => {
      const mod = url.startsWith('https') ? https : http;
      const req = mod.get(url, {
        timeout: 20000, signal,
        headers: { Accept: '*/*', Range: 'bytes=0-1' },
      }, (res) => {
        res.resume();
        resolve({ status: res.statusCode, cr: res.headers['content-range'] || '' });
      });
      req.on('timeout', () => req.destroy(new Error('探测超时')));
      req.on('error', (e) => resolve({ err: e }));
    });
    if (probe.err || probe.status !== 206) return this._download(url, target, 3, signal);   // 不支持 Range
    const m = /\/(\d+)\s*$/.exec(probe.cr);
    const total = m ? Number(m[1]) : 0;
    if (total && BLOCK_SIZES.has(total)) throw new Error(`反盗版占位文件（${total} 字节）`);
    if (!total || total < SEG_MIN_SIZE) return this._download(url, target, 3, signal);
    try {
      await this._downloadMultiSeg(url, target, total, signal);
    } catch (e) {
      const msg = String(e && e.message || e);
      if ((e && e.name === 'AbortError') || msg.indexOf('已停止') >= 0) throw e;   // 停止不回退
      // 任一段失败（CDN 瞬时 416 限速等）→ 回退单流整段
      return this._download(url, target, 3, signal);
    }
  }

  /** 多线程分段：N 段并行 Range 下载到 .segN，全部成功后顺序拼接为 .part 再落正名。 */
  async _downloadMultiSeg(url, target, size, signal) {
    const n = Math.min(SEGMENTS, Math.max(2, Math.floor(size / (1024 * 1024))));
    const chunk = Math.floor(size / n);
    const bounds = [];
    let s = 0;
    for (let i = 0; i < n; i++) {
      const end = (i === n - 1) ? size - 1 : s + chunk - 1;
      bounds.push([s, end]);
      s += chunk;
    }
    try {
      await Promise.all(bounds.map(([a, b], i) =>
        this._segRange(url, target + '.seg' + i, a, b, signal)));
    } catch (e) {
      for (let i = 0; i < n; i++) { try { fs.unlinkSync(target + '.seg' + i); } catch (_) {} }
      throw e;
    }
    // 顺序拼接所有段 → target.part
    const out = fs.createWriteStream(target + '.part');
    try {
      for (let i = 0; i < n; i++) {
        const segPath = target + '.seg' + i;
        const data = fs.readFileSync(segPath);
        if (!out.write(data)) await new Promise((r) => out.once('drain', r));
        fs.unlinkSync(segPath);
      }
    } catch (e) {
      try { out.destroy(); } catch (_) {}
      try { fs.unlinkSync(target + '.part'); } catch (_) {}
      throw e;
    }
    await new Promise((resolve) => out.end(resolve));
    await fs.promises.rename(target + '.part', target);
  }

  /** 单段 Range 下载（206 校验，超时/中断自动清理段文件）。 */
  _segRange(url, dest, start, end, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(new Error('已停止'));
      const mod = url.startsWith('https') ? https : http;
      const req = mod.get(url, {
        timeout: 60000, signal,
        headers: { Accept: '*/*', Range: `bytes=${start}-${end}` },
      }, (res) => {
        if (res.statusCode !== 206) {
          res.resume();
          return reject(new Error('SEG_NOT_206:' + res.statusCode));
        }
        const f = fs.createWriteStream(dest, { signal: signal || undefined });
        res.pipe(f);
        f.on('finish', () => f.close(resolve));
        f.on('error', (e) => {
          try { req.destroy(); } catch (_) {}
          try { fs.unlinkSync(dest); } catch (_) {}
          reject(e);
        });
      });
      req.on('timeout', () => req.destroy(new Error('下载超时')));
      req.on('error', (e) => {
        try { fs.unlinkSync(dest); } catch (_) {}
        reject(e);
      });
    });
  }

  _download(url, target, redirectsLeft = 3, signal = null) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(new Error('已停止'));
      const file = fs.createWriteStream(target + '.part');
      const mod = url.startsWith('https') ? https : http;
      const req = mod.get(url, { timeout: 60000, signal, headers: { Accept: '*/*' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
          res.resume();
          file.close();
          return this._download(res.headers.location, target, redirectsLeft - 1, signal).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          file.close(() => fs.unlink(target + '.part', () => {}));
          return reject(new Error('HTTP ' + res.statusCode));
        }
        // 反盗版拦截（下载时中止，不落盘）：Content-Length 命中占位字节黑名单 → 一个字节都不写
        const clen = Number(res.headers['content-length']) || 0;
        if (clen && BLOCK_SIZES.has(clen)) {
          res.destroy();
          file.destroy();
          try { fs.unlinkSync(target + '.part'); } catch (_) {}
          return reject(new Error(`反盗版占位文件（${clen} 字节）`));
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => fs.rename(target + '.part', target, resolve)));
      });
      req.on('timeout', () => req.destroy(new Error('下载超时')));
      req.on('error', (e) => {
        file.close(() => fs.unlink(target + '.part', () => reject(e)));
      });
      file.on('error', (e) => {
        try { req.destroy(); } catch (_) {}
        try { fs.unlinkSync(target + '.part'); } catch (_) {}
        reject(e);
      });
    });
  }
}

module.exports = { BulkDownloader };
