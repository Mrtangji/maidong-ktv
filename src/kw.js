'use strict';
/**
 * 内置酷我(kw)源：搜索 + 歌词 + 点唱榜。
 * 逐行移植自 maidong-ktv app/src/main/java/com/local/ktv/KwSource.kt。
 */

const crypto = require('crypto');
const zlib = require('zlib');
const http = require('http');
const https = require('https');
const { URL, URLSearchParams } = require('url');

const ID = 'kw';
const NAME = '酷我搜索（内置）';

// ---------- 基础 HTTP ----------

function request(url, timeoutMs = 12_000) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method: 'GET',
      timeout: timeoutMs,
      headers: { 'User-Agent': 'MaidongKTV/1.0' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, target).toString(); } catch (_) { return reject(new Error('bad redirect')); }
        return request(next, timeoutMs).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        try {
          if (enc.includes('gzip')) buf = zlib.gunzipSync(buf);
          else if (enc.includes('deflate')) buf = zlib.inflateSync(buf);
          else if (enc.includes('br')) buf = zlib.brotliDecompressSync(buf);
        } catch (_) { /* 忽略解压失败 */ }
        resolve({ status: res.statusCode, body: buf });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    req.end();
  });
}

const encode = encodeURIComponent;

function inflate(data) {
  try {
    return zlib.inflateSync(data);
  } catch (_) {
    return zlib.inflateRawSync(data);
  }
}

function formatSinger(value) {
  return String(value || '').replace(/&|\/|,/g, '、').trim();
}

function musicInfo(songId, title, singer) {
  // 构造交给 LX 脚本的通用 musicInfo（字段尽量全，兼容不同脚本取值）
  return {
    songmid: songId,
    songId,
    musicId: songId,
    hash: songId,
    id: songId,
    name: title,
    singer,
    singerName: singer,
    source: 'kw',
  };
}

// ---------- 搜索 ----------

async function search(keyword, page = 1, limit = 30) {
  const url = 'http://search.kuwo.cn/r.s?client=kt&all=' + encode(keyword) +
    `&pn=${Math.max(page - 1, 0)}&rn=${limit}&uid=794762570&ver=kwplayer_ar_9.2.2.1` +
    '&vipver=1&show_copyright_off=1&newver=1&ft=music&cluster=0&strategy=2012' +
    '&encoding=utf8&rformat=json&vermerge=1&mobi=1&issubtitle=1';
  const resp = await request(url, 12_000);
  if (resp.status !== 200) throw new Error(`酷我搜索 HTTP ${resp.status}`);
  const body = JSON.parse(resp.body.toString('utf8'));
  const list = Array.isArray(body.abslist) ? body.abslist : [];
  return list.map((item) => {
    const songId = String(item.MUSICRID || item.musicrid || '').replace(/^MUSIC_/, '');
    if (!songId) return null;
    const title = item.SONGNAME || '未知歌名';
    const singer = formatSinger(item.ARTIST);
    return {
      sourceId: ID,
      sourceName: NAME,
      songId,
      title,
      singer,
      album: item.ALBUM || '',
      pic: item.hts_MVPIC || item.web_albumpic_short || '',
      musicInfo: musicInfo(songId, title, singer),
    };
  }).filter(Boolean);
}

// ---------- 歌词 ----------
// 参数串与 'yeelion' 逐字节 XOR 后 base64 → newlyric.lrc →
// "tp=content\r\n...\r\n\r\n" + zlib inflate → GB18030 LRC 文本。

async function lyric(songId) {
  const params = `user=12345,web,web,web&requester=localhost&req=1&rid=MUSIC_${songId}`;
  const key = Buffer.from('yeelion', 'ascii');
  const out = Buffer.from(params, 'utf8');
  for (let i = 0; i < out.length; i++) out[i] ^= key[i % key.length];
  const url = 'http://newlyric.kuwo.cn/newlyric.lrc?' + encodeURIComponent(out.toString('base64'));
  const resp = await request(url, 15_000);
  if (resp.status !== 200) throw new Error(`歌词接口 HTTP ${resp.status}`);
  const body = resp.body;
  const head = body.subarray(0, Math.min(10, body.length)).toString('ascii');
  if (head !== 'tp=content') throw new Error('歌词接口响应异常');
  let split = -1;
  for (let i = 0; i < body.length - 3; i++) {
    if (body[i] === 0x0d && body[i + 1] === 0x0a && body[i + 2] === 0x0d && body[i + 3] === 0x0a) {
      split = i + 4;
      break;
    }
  }
  if (split < 0) throw new Error('歌词数据格式异常');
  const payload = inflate(body.subarray(split));
  const lrc = new TextDecoder('gb18030').decode(payload);
  if (!/\[\d{1,2}:\d{2}/.test(lrc)) throw new Error('歌词内容为空');
  return lrc;
}

// ---------- 点唱榜（15 个酷我榜单，AES-128-ECB） ----------

const BOARDS = [
  ['255', 'KTV点唱榜'], ['93', '飙升榜'], ['17', '新歌榜'], ['16', '热歌榜'],
  ['158', '抖音热歌榜'], ['187', '流行趋势榜'], ['26', '经典怀旧榜'], ['104', '华语榜'],
  ['182', '粤语榜'], ['22', '欧美榜'], ['64', '影视金曲榜'], ['176', 'DJ嗨歌榜'],
  ['185', '最强翻唱榜'], ['186', 'ACG神曲榜'], ['278', '古风音乐榜'],
].map(([bangId, name]) => ({ id: `kw__${bangId}`, name, bangId }));

const KW_AES_KEY = Buffer.from([
  112, 87, 39, 61, 199, 250, 41, 191,
  57, 68, 45, 114, 221, 94, 140, 228,
]);
const KW_APP_ID = 'y67sprxhhpws';

function kwMd5Upper(value) {
  return crypto.createHash('md5').update(Buffer.from(value, 'utf8')).digest('hex').toUpperCase();
}

function kwBuildParam(jsonData) {
  const cipher = crypto.createCipheriv('aes-128-ecb', KW_AES_KEY, null);
  const enc = Buffer.concat([cipher.update(Buffer.from(jsonData, 'utf8')), cipher.final()]).toString('base64');
  const time = Date.now();
  return `data=${encodeURIComponent(enc)}&time=${time}&appId=${KW_APP_ID}` +
    `&sign=${kwMd5Upper(KW_APP_ID + enc + time)}`;
}

function kwDecodeBody(text) {
  // 对齐 Kotlin URLDecoder.decode：'+' → 空格、%xx 还原；空格在 base64 中按 '+' 还原
  let t = String(text).trim();
  try { t = decodeURIComponent(t.replace(/\+/g, '%20')); } catch (_) { /* 保持原样 */ }
  const b64 = t.replace(/\s+/g, '+');
  const raw = Buffer.from(b64, 'base64');
  const decipher = crypto.createDecipheriv('aes-128-ecb', KW_AES_KEY, null);
  return JSON.parse(Buffer.concat([decipher.update(raw), decipher.final()]).toString('utf8'));
}

async function boardSongs(bangId, page = 1, limit = 100) {
  const body = JSON.stringify({
    uid: '',
    devId: '',
    sFrom: 'kuwo_sdk',
    user_type: 'AP',
    carSource: 'kwplayercar_ar_6.0.1.0_apk_keluze.apk',
    id: bangId,
    pn: page - 1,
    rn: limit,
  });
  const url = `https://wbd.kuwo.cn/api/bd/bang/bang_info?${kwBuildParam(body)}`;
  const resp = await request(url, 12_000);
  if (resp.status !== 200) throw new Error(`榜单接口 HTTP ${resp.status}`);
  const raw = kwDecodeBody(resp.body.toString('utf8'));
  if (raw.code !== 200) throw new Error('榜单数据获取失败');
  const musiclist = (raw.data && raw.data.musiclist) || [];
  return musiclist.map((item) => {
    const songId = String(item.songmid || String(item.id || item.MUSICRID || '').replace(/^MUSIC_/, ''));
    if (!songId) return null;
    const title = item.name || item.SONGNAME || '未知歌名';
    const singer = item.singer || formatSinger(item.ARTIST || item.artist);
    return {
      sourceId: ID,
      sourceName: NAME,
      songId,
      title,
      singer,
      album: item.albumName || item.ALBUM || '',
      pic: item.pic || item.img || item.picPath || '',
      musicInfo: musicInfo(songId, title, singer),
    };
  }).filter(Boolean);
}

module.exports = { ID, NAME, search, lyric, boardSongs, BOARDS, musicInfo };
