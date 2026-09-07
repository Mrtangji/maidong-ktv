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
const { LibraryCache } = require('./src/cache');
const { SongQueue } = require('./src/queue');

const VERSION = '1.0.0';
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

// ---------- 曲库缓存 + 点歌队列 ----------

const cache = new LibraryCache(DATA_DIR, MUSIC_DIR, {
  resolveMusicUrl: (musicInfo, quality) => sandbox.resolveMusicUrl(musicInfo, quality),
  fetchLyric: (songId) => kw.lyric(songId),
});

const queue = new SongQueue(DATA_DIR);

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

/** 带Range支持的音频文件播放（电视端拖动进度必需）。 */
function serveMediaFile(req, res, filePath, filename) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const range = req.headers.range;
    const baseHeaders = {
      'Accept-Ranges': 'bytes',
      'Content-Type': 'audio/mpeg',
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
    if (!sandbox.ready) return sendJson(res, 409, { error: '尚未导入 LX 音源脚本（/api/v1/lx/import）' });
    const url = await sandbox.resolveMusicUrl(song.musicInfo, song.quality);
    if (!url) return sendJson(res, 502, { error: '解析失败：音源脚本未返回有效链接' });
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
    if (!sandbox.ready) return sendJson(res, 409, { error: '尚未导入 LX 音源脚本' });
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
  const libRemove = p.match(/^\/api\/v1\/library\/([^/]+)$/);
  if (libRemove && req.method === 'DELETE') {
    const ok = cache.remove(decodeURIComponent(libRemove[1]));
    return sendJson(res, ok ? 200 : 404, { ok });
  }

  // ----- 点歌队列 -----
  if (p === '/api/v1/queue' && req.method === 'GET') {
    return sendJson(res, 200, { items: queue.list(), history: queue.history(), current: queue.current() });
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

  // 1) 曲库缓存命中 → 直接播 NAS 上的文件（支持 Range）
  const cached = cache.songs[song.songId];
  if (cached && cache.has(song.songId)) {
    return serveMediaFile(req, res, path.join(MUSIC_DIR, cached.file), path.basename(cached.file));
  }

  // 2) 未缓存 → 解析后 302 到直链，同时后台缓存到 NAS
  if (!sandbox.ready) return sendJson(res, 409, { error: '尚未导入 LX 音源脚本' });
  sandbox.resolveMusicUrl(song.musicInfo, song.quality).then((remoteUrl) => {
    if (!remoteUrl) return sendJson(res, 502, { error: '解析失败：音源脚本未返回有效链接' });
    cache.autoCache(song);
    res.writeHead(302, { Location: remoteUrl, 'Access-Control-Allow-Origin': '*' });
    res.end();
  }).catch((e) => sendJson(res, 502, { error: e.message }));
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
