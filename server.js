'use strict';
/**
 * maidong-ktv-server —— 麦动 KTV 服务端（独立部署版）
 *
 * 三层架构（对齐 junyao/ktv-home 部署模式）：
 *   服务端（本工程，docker 部署到 NAS）+ 电视端（/tv 或安卓 APK）+ 手机端（/m）
 * 音源：内置酷我搜索/歌词/榜单 + LX 沙箱脚本解析 musicUrl
 * 曲库：全量缓存到 NAS 卷 /music，索引在 /data
 *
 * 零 npm 依赖，Node >= 18 即可运行。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const os = require('os');

const { LxSandbox } = require('./src/lx-sandbox');
const kw = require('./src/kw');
const kwUrl = require('./src/kw-url');
const { LibraryCache } = require('./src/cache');
const { BulkDownloader } = require('./src/bulk');
const { SongQueue } = require('./src/queue');

const VERSION = '1.1.0';
const PORT = Number(process.env.PORT || 8080);
const DISCOVERY_PORT = Number(process.env.DISCOVERY_PORT || 18888);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MUSIC_DIR = process.env.MUSIC_DIR || path.join(__dirname, 'music');
const WEB_DIR = path.join(__dirname, 'web');
const LX_DIR = path.join(DATA_DIR, 'lx');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(MUSIC_DIR, { recursive: true });
fs.mkdirSync(LX_DIR, { recursive: true });

// ---------- LX 沙箱 + 脚本持久化 ----------

const sandbox = new LxSandbox();

function persistLx(scriptText) {
  fs.writeFileSync(path.join(LX_DIR, 'script.js'), scriptText, 'utf8');
  fs.writeFileSync(path.join(LX_DIR, 'meta.json'), JSON.stringify(sandbox.currentInfo(), null, 2), 'utf8');
}

function clearPersistedLx() {
  ['script.js', 'meta.json'].forEach((f) => {
    try { fs.unlinkSync(path.join(LX_DIR, f)); } catch (_) { /* ignore */ }
  });
}

async function importLxScript(scriptText) {
  const result = await sandbox.load(scriptText);
  if (!result.ok) return result;
  persistLx(scriptText);
  return result;
}

// 启动时恢复已导入的脚本
(async () => {
  const scriptPath = path.join(LX_DIR, 'script.js');
  if (fs.existsSync(scriptPath)) {
    try {
      const text = fs.readFileSync(scriptPath, 'utf8');
      const result = await sandbox.load(text);
      console.log(`[lx] 恢复音源脚本: ${result.ok ? '成功 ' + (result.name || '') : '失败 ' + result.error}`);
    } catch (e) {
      console.error('[lx] 恢复音源脚本异常:', e.message);
    }
  }
})();

// ---------- 统一直链解析：内置酷我优先（免 LX 脚本），失败回退 LX ----------

function songIdOf(song) {
  return String(song && (song.songId || song.musicId || song.songmid || song.id) || '').replace(/^MUSIC_/i, '');
}

async function resolveSongUrl(song) {
  const viaKw = await kwUrl.resolveKwUrl(songIdOf(song), song && song.quality);
  if (viaKw) return viaKw;
  if (sandbox.ready) return sandbox.resolveMusicUrl(song && song.musicInfo, (song && song.quality) || '128k');
  return null;
}

// ---------- 曲库缓存 + 点歌队列 ----------

const cache = new LibraryCache(DATA_DIR, MUSIC_DIR, {
  resolveMusicUrl: (musicInfo, quality) => resolveSongUrl({ ...musicInfo, quality }),
  fetchLyric: (songId) => kw.lyric(songId),
});

const queue = new SongQueue(DATA_DIR);

// muse.db 全库批量下载（最常唱优先）
const bulk = new BulkDownloader(DATA_DIR, MUSIC_DIR);

// ---------- 工具 ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function serveFile(res, filePath, headers = {}) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
      ...headers,
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/** 带Range支持的媒体文件播放（电视端拖动进度/断点续传必需）。 */
function serveMediaFile(req, res, filePath, filename, contentType = 'audio/mpeg') {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const range = req.headers.range;
    const baseHeaders = {
      'Accept-Ranges': 'bytes',
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    };
    if (filename) baseHeaders['Content-Disposition'] = `inline; filename*=UTF-8''${encodeURIComponent(filename)}`;
    if (!range) {
      res.writeHead(200, { ...baseHeaders, 'Content-Length': stat.size });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
    const m = String(range).match(/bytes=(\d*)-(\d*)/);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (isNaN(start) || start < 0) start = 0;
    if (isNaN(end) || end >= stat.size) end = stat.size - 1;
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      ...baseHeaders,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Content-Length': end - start + 1,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  });
}

// ---------- 播放/解析 ----------

function buildSongFromQuery(query) {
  const songId = String(query.get('songId') || '');
  if (!songId) return null;
  const title = query.get('title') || '';
  const singer = query.get('singer') || '';
  return {
    songId,
    title,
    singer,
    album: query.get('album') || '',
    pic: query.get('pic') || '',
    quality: query.get('quality') || '128k',
    musicInfo: kw.musicInfo(songId, title, singer),
  };
}

// ---------- 路由 ----------

async function handleApi(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;

  // ----- 健康 / 音源 -----
  if (p === '/api/v1/health' && req.method === 'GET') {
    return sendJson(res, 200, { app: 'maidong-ktv-server', version: VERSION, ready: sandbox.ready });
  }
  if (p === '/api/v1/sources' && req.method === 'GET') {
    return sendJson(res, 200, {
      kw: { id: kw.ID, name: kw.NAME, actions: ['search', 'lyric', 'board'] },
      lx: sandbox.currentInfo(),
    });
  }

  // ----- LX 音源脚本管理 -----
  if (p === '/api/v1/lx/import' && req.method === 'POST') {
    const body = await readBody(req);
    let script = null;
    const contentType = String(req.headers['content-type'] || '');
    if (contentType.includes('application/json')) {
      try { script = JSON.parse(body.toString('utf8')).script; } catch (_) { /* ignore */ }
    }
    if (script == null) script = body.toString('utf8');
    if (!script || script.length < 32) return sendJson(res, 400, { ok: false, error: '脚本内容为空' });
    const result = await importLxScript(script);
    return sendJson(res, result.ok ? 200 : 400, result);
  }
  if (p === '/api/v1/lx/current' && req.method === 'GET') {
    return sendJson(res, 200, sandbox.currentInfo());
  }
  if (p === '/api/v1/lx/current' && req.method === 'DELETE') {
    clearPersistedLx();
    await sandbox.load('// cleared');
    sandbox.ready = false;
    return sendJson(res, 200, { ok: true });
  }

  // ----- 搜索 / 榜单 / 歌词 -----
  if (p === '/api/v1/search' && req.method === 'GET') {
    const keyword = (q.get('keyword') || '').trim();
    if (!keyword) return sendJson(res, 400, { error: '缺少 keyword' });
    const page = Number(q.get('page') || 1);
    const limit = Math.min(Number(q.get('limit') || 30), 50);
    try {
      const songs = await kw.search(keyword, page, limit);
      return sendJson(res, 200, { keyword, page, limit, songs: songs.map((s) => ({ ...s, cached: cache.has(s.songId) })) });
    } catch (e) {
      return sendJson(res, 502, { error: e.message });
    }
  }
  if (p === '/api/v1/board' && req.method === 'GET') {
    return sendJson(res, 200, { boards: kw.BOARDS });
  }
  if (p === '/api/v1/board/songs' && req.method === 'GET') {
    const id = q.get('id') || '';
    const board = kw.BOARDS.find((b) => b.id === id);
    if (!board) return sendJson(res, 400, { error: '未知榜单 id' });
    try {
      const songs = await kw.boardSongs(board.bangId, Number(q.get('page') || 1), Math.min(Number(q.get('limit') || 100), 100));
      return sendJson(res, 200, { board: board.name, songs: songs.map((s) => ({ ...s, cached: cache.has(s.songId) })) });
    } catch (e) {
      return sendJson(res, 502, { error: e.message });
    }
  }
  if (p === '/api/v1/lyric' && req.method === 'GET') {
    const songId = q.get('songId') || '';
    if (!songId) return sendJson(res, 400, { error: '缺少 songId' });
    try {
      return sendJson(res, 200, { songId, lyric: await kw.lyric(songId) });
    } catch (e) {
      return sendJson(res, 404, { error: e.message });
    }
  }

  // ----- 解析播放地址（播放时自动入 NAS 曲库） -----
  if (p === '/api/v1/song/url' && req.method === 'GET') {
    const song = buildSongFromQuery(q);
    if (!song) return sendJson(res, 400, { error: '缺少 songId' });
    const url = await resolveSongUrl(song);
    if (!url) return sendJson(res, 502, { error: '解析失败：无可用播放地址（内置酷我与 LX 脚本均未命中）' });
    cache.autoCache(song);
    return sendJson(res, 200, { songId: song.songId, quality: song.quality, url, cached: cache.has(song.songId) });
  }

  // ----- 曲库（NAS 缓存） -----
  if (p === '/api/v1/library' && req.method === 'GET') {
    return sendJson(res, 200, { songs: cache.list(), status: cache.status() });
  }
  if (p === '/api/v1/library/cache' && req.method === 'POST') {
    const body = await readBody(req);
    let payload;
    try { payload = JSON.parse(body.toString('utf8')); } catch (_) { return sendJson(res, 400, { error: 'JSON 解析失败' }); }
    const songs = Array.isArray(payload) ? payload : (payload.songs || [payload]);
    const added = cache.batchCache(songs);
    return sendJson(res, 200, { ok: true, added, status: cache.status() });
  }
  if (p === '/api/v1/library/status' && req.method === 'GET') {
    return sendJson(res, 200, cache.status());
  }
  if (p === '/api/v1/library/status/clear-failed' && req.method === 'POST') {
    cache.failed = {};
    return sendJson(res, 200, cache.status());
  }

  // ----- muse.db 全库批量下载（最常唱优先） -----
  if (p === '/api/v1/bulk/status' && req.method === 'GET') {
    return sendJson(res, 200, bulk.status());
  }
  if (p === '/api/v1/bulk/import' && req.method === 'POST') {
    try {
      const n = await bulk.importCatalog();
      return sendJson(res, 200, { ok: true, catalog: n });
    } catch (e) { return sendJson(res, 500, { error: e.message }); }
  }
  if (p === '/api/v1/bulk/start' && req.method === 'POST') {
    const body = await readBody(req);
    let opts = {};
    try { opts = JSON.parse(body.toString('utf8') || '{}') || {}; } catch (_) {}
    const r = bulk.start(opts);
    return sendJson(res, r.ok ? 200 : 409, r);
  }
  if (p === '/api/v1/bulk/stop' && req.method === 'POST') {
    return sendJson(res, 200, bulk.stop());
  }
  const libRemove = p.match(/^\/api\/v1\/library\/([^/]+)$/);
  if (libRemove && req.method === 'DELETE') {
    const ok = cache.remove(decodeURIComponent(libRemove[1]));
    return sendJson(res, ok ? 200 : 404, { ok });
  }

  // ----- 点歌队列 -----
  if (p === '/api/v1/queue' && req.method === 'GET') {
    return sendJson(res, 200, { items: queue.list(), history: queue.getHistory(), current: queue.current() });
  }
  if (p === '/api/v1/queue' && req.method === 'POST') {
    const body = await readBody(req);
    let song;
    try { song = JSON.parse(body.toString('utf8')); } catch (_) { return sendJson(res, 400, { error: 'JSON 解析失败' }); }
    if (!song.songId) return sendJson(res, 400, { error: '缺少 songId' });
    if (!song.musicInfo) song.musicInfo = kw.musicInfo(song.songId, song.title || '', song.singer || '');
    const item = queue.add(song);
    if (!item) return sendJson(res, 200, { ok: false, error: '歌曲已在队列中' });
    return sendJson(res, 200, { ok: true, item, items: queue.list() });
  }
  if (p === '/api/v1/queue/played' && req.method === 'POST') {
    const item = queue.played(Number(q.get('index') || 0));
    return sendJson(res, 200, { ok: !!item, items: queue.list() });
  }
  const queueRemove = p.match(/^\/api\/v1\/queue\/(\d+)$/);
  if (queueRemove && req.method === 'DELETE') {
    const item = queue.remove(queueRemove[1]);
    return sendJson(res, item ? 200 : 404, { ok: !!item, items: queue.list() });
  }
  if (p === '/api/v1/queue/clear' && req.method === 'POST') {
    return sendJson(res, 200, { ok: true, removed: queue.clear() });
  }

  return null; // 未匹配
}

function handleStream(req, res, url) {
  const song = buildSongFromQuery(url.searchParams);
  if (!song) return sendJson(res, 400, { error: '缺少 songId' });

  (async () => {
    // 1) 曲库缓存命中 → 直接播 NAS 上的文件（支持 Range）
    const serve = () => {
      const cached = cache.songs[song.songId];
      if (cached && cache.has(song.songId)) {
        serveMediaFile(req, res, path.join(MUSIC_DIR, cached.file), path.basename(cached.file));
        return true;
      }
      return false;
    };
    if (serve()) return;

    // 2) 该曲已在下载中 → 等它落盘后直接从缓存服务（避免并发重复下载）
    const state = await cache.waitUntilCached(song.songId, 120_000);
    if (state === 'cached' && serve()) return;
    if (state === 'busy') return sendJson(res, 503, { error: 'NAS 正在缓存该歌曲，请稍后重试' });

    // 3) 未缓存 → 解析直链 → NAS 边代下载给客户端、边落盘入曲库（首次稍慢，之后走局域网）
    const remoteUrl = await resolveSongUrl(song);
    if (!remoteUrl) return sendJson(res, 502, { error: '解析失败：无可用播放地址' });
    const { file } = cache.targetsFor(song, remoteUrl);
    const target = path.join(MUSIC_DIR, file);
    const lrcPromise = kw.lyric(song.songId).catch(() => null); // 歌词尽力而为，与下载并行
    cache.activeSongs.add(song.songId); // 代理缓存期间，阻止 autoCache 重复下载同一文件
    try {
      await proxyAndCache(remoteUrl, res, { targetPath: target, contentType: 'audio/mpeg' });
      const lrcText = await lrcPromise;
      cache.registerFile(song, file, lrcText);
    } catch (e) {
      console.error('[stream] 代理缓存失败:', e.message);
      if (!res.headersSent) sendJson(res, 502, { error: '拉取失败: ' + e.message });
      else res.end();
    } finally {
      cache.activeSongs.delete(song.songId);
    }
  })().catch((e) => {
    console.error('[stream]', e);
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
  });
}

/**
 * 代理并缓存：从 remoteUrl 拉流，转发给客户端的同时写入 targetPath(.part)，
 * 完成后原子改名。客户端中途断开（切歌）不中断后台落盘。
 */
function proxyAndCache(remoteUrl, res, opts = {}) {
  return new Promise((resolve, reject) => {
    const targetPath = opts.targetPath;
    const doGet = (u, redirectsLeft) => {
      let target_;
      try { target_ = new URL(u); } catch (e) { return reject(new Error('invalid url')); }
      const lib = target_.protocol === 'https:' ? require('https') : http;
      const up = lib.request({
        hostname: target_.hostname,
        port: target_.port || (target_.protocol === 'https:' ? 443 : 80),
        path: target_.pathname + target_.search,
        method: 'GET',
        headers: { 'User-Agent': opts.ua || 'MaidongKTV/1.0', Referer: target_.origin },
        timeout: 30_000,
      }, (upRes) => {
        try {
        if (upRes.statusCode >= 300 && upRes.statusCode < 400 && upRes.headers.location && redirectsLeft > 0) {
          upRes.resume();
          let next;
          try { next = new URL(upRes.headers.location, target_).toString(); } catch (_) { return reject(new Error('bad redirect')); }
          return doGet(next, redirectsLeft - 1);
        }
        if (upRes.statusCode !== 200) {
          upRes.resume();
          return reject(new Error(`上游 HTTP ${upRes.statusCode}`));
        }
        const out = targetPath ? fs.createWriteStream(`${targetPath}.part`) : null;
        if (!res.headersSent) {
          const headers = {
            'Accept-Ranges': 'bytes',
            'Content-Type': opts.contentType || 'application/octet-stream',
            'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': '*',
          };
          const len = parseInt(upRes.headers['content-length'] || '', 10);
          if (Number.isFinite(len) && len > 0) headers['Content-Length'] = len;
          res.writeHead(200, headers);
        }
        let clientGone = false;
        res.on('close', () => { clientGone = true; });
        upRes.on('data', (chunk) => {
          if (out) out.write(chunk);
          if (!clientGone && !res.destroyed) res.write(chunk); // 局域网场景不做背压反压
        });
        upRes.on('error', finish);
        upRes.on('end', () => finish(null));
        function finish(err) {
          if (out) {
            out.end(() => {
              if (err && !clientGone) {
                try { fs.unlinkSync(`${targetPath}.part`); } catch (_) { /* ignore */ }
                return reject(err);
              }
              if (targetPath) {
                try {
                  fs.renameSync(`${targetPath}.part`, targetPath);
                } catch (e) { if (!clientGone) return reject(e); }
              }
              resolve();
              if (!clientGone) res.end();
            });
          } else {
            if (err && !clientGone) return reject(err);
            resolve();
            if (!clientGone) res.end();
          }
        }
        } catch (err) {
          try { upRes.destroy(); } catch (_) { /* ignore */ }
          reject(err);
        }
      });
      up.on('timeout', () => up.destroy(new Error('上游超时')));
      up.on('error', reject);
      up.end();
    };
    doGet(remoteUrl, 5);
  });
}

// ---------- /ts/<filename>：muse.db 原生曲库 .ts 缓存（与 muse.db 条目同名对应） ----------

const TS_DIR = path.join(MUSIC_DIR, 'ts');
const tsInflight = new Map(); // filename -> Promise

function tsContentType(filename) {
  return /\.(ts|ls)$/i.test(filename) ? 'video/mp2t' : 'application/octet-stream';
}

async function handleTs(req, res, filename, query) {
  if (!/^[\w\u4e00-\u9fa5\-. ]+\.(ts|ls)$/i.test(filename)) {
    return sendJson(res, 400, { error: '非法文件名' });
  }
  fs.mkdirSync(TS_DIR, { recursive: true });
  const target = path.join(TS_DIR, filename);

  // 1) NAS 缓存命中 → 局域网直接服务（支持 Range 断点续传）
  if (fs.existsSync(target) && fs.statSync(target).size > 0) {
    return serveMediaFile(req, res, target, filename, tsContentType(filename));
  }

  // 2) 未命中 → 需要 src（app 解析好的 CDN 直链），NAS 代下载并缓存
  const src = query.get('src') || '';
  if (!/^https?:\/\//.test(src)) {
    return sendJson(res, 404, { error: 'NAS 未缓存该歌曲，且缺少 src 源地址' });
  }

  // 并发去重：同文件已在下载中 → 等它完成后从缓存服务
  const inflight = tsInflight.get(filename);
  if (inflight) {
    try { await inflight; } catch (_) { /* ignore */ }
    if (fs.existsSync(target) && fs.statSync(target).size > 0) {
      return serveMediaFile(req, res, target, filename, tsContentType(filename));
    }
    return sendJson(res, 502, { error: 'NAS 代下载失败，请重试' });
  }

  let done, fail;
  const promise = new Promise((r, j) => { done = r; fail = j; });
  tsInflight.set(filename, promise);
  try {
    console.log(`[ts] 缓存未命中，代下载: ${filename}`);
    await proxyAndCache(src, res, { targetPath: target, contentType: tsContentType(filename) });
    const size = fs.existsSync(target) ? fs.statSync(target).size : 0;
    console.log(`[ts] 已缓存: ${filename} (${(size / 1024 / 1024).toFixed(1)}MB)`);
    bulk.friendlyLinkByFile(filename);   // 同步产出 music/<歌手 - 歌名>.ts 硬链接
    done();
  } catch (e) {
    fail(e);
    console.error(`[ts] 代下载失败: ${filename}`, e.message);
    if (!res.headersSent) sendJson(res, 502, { error: '代下载失败: ' + e.message });
    else res.end();
  } finally {
    tsInflight.delete(filename);
  }
}

function handleStatic(req, res, url) {
  const p = url.pathname;
  if (p === '/' || p === '/tv') return serveFile(res, path.join(WEB_DIR, 'tv', 'index.html'));
  if (p === '/m') return serveFile(res, path.join(WEB_DIR, 'm', 'index.html'));
  if (p.startsWith('/tv/')) {
    const rel = p.slice('/tv/'.length).replace(/\.\./g, '');
    return serveFile(res, path.join(WEB_DIR, 'tv', rel));
  }
  if (p.startsWith('/m/')) {
    const rel = p.slice('/m/'.length).replace(/\.\./g, '');
    return serveFile(res, path.join(WEB_DIR, 'm', rel));
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (_) {
    res.writeHead(400); res.end(); return;
  }

  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((e) => {
      console.error('[api]', url.pathname, e);
      if (!res.headersSent) sendJson(res, 500, { error: e.message });
    });
    return;
  }
  if (url.pathname === '/stream') {
    handleStream(req, res, url);
    return;
  }
  const tsMatch = url.pathname.match(/^\/ts\/(.+)$/);
  if (tsMatch && req.method === 'GET') {
    handleTs(req, res, decodeURIComponent(tsMatch[1]), url.searchParams).catch((e) => {
      console.error('[ts]', e);
      if (!res.headersSent) sendJson(res, 500, { error: e.message });
    });
    return;
  }
  handleStatic(req, res, url);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[maidong-ktv-server] v${VERSION} listening on http://0.0.0.0:${PORT}`);
  console.log(`  电视端: http://<NAS_IP>:${PORT}/tv   手机端: http://<NAS_IP>:${PORT}/m`);
  console.log(`  曲库卷: ${MUSIC_DIR}   数据卷: ${DATA_DIR}`);
});

// ---------- UDP 局域网发现（对齐 ktv-home：18888 广播 + 应答扫描） ----------

const DISCOVER_MSG = 'MAIDONG_DISCOVER';
const ANNOUNCE = JSON.stringify({ app: 'maidong-ktv', v: 1, port: PORT, name: os.hostname() });

const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
udp.on('error', (e) => console.error('[discovery]', e.message));
udp.on('message', (msg, rinfo) => {
  if (msg.toString().trim() === DISCOVER_MSG) {
    udp.send(Buffer.from(ANNOUNCE), rinfo.port, rinfo.address);
  }
});
udp.bind(DISCOVERY_PORT, () => {
  udp.setBroadcast(true);
  setInterval(() => {
    ['255.255.255.255'].forEach((addr) => {
      try { udp.send(Buffer.from(ANNOUNCE), DISCOVERY_PORT, addr); } catch (_) { /* ignore */ }
    });
  }, 3000);
  console.log(`[discovery] UDP ${DISCOVERY_PORT} 广播/应答已启动`);
});
