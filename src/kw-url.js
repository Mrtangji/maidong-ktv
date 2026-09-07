'use strict';
/**
 * 内置酷我直链解析（不依赖 LX 音源脚本）。
 *
 * antiserver.kuwo.cn convert_url 接口：
 *   - response=url 时直接以文本返回播放地址（或 302 Location）
 *   - 2026-09 实测可用：128k 稳定；320k 参数通常也返回 128k 流
 * 失败时（接口变动/风控）返回 null，由调用方回退 LX 脚本解析。
 */
const https = require('https');
const http = require('http');

function fetchText(url, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('invalid url')); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'User-Agent': 'MaidongKTV/1.0' },
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(String(res.headers.location));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').trim()));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

function looksLikeAudioUrl(value) {
  return /^https?:\/\//.test(value) && (/\.mp3($|[?#])/i.test(value) || /\/resource\//i.test(value) || /\.flac($|[?#])/i.test(value) || /\.m4a($|[?#])/i.test(value));
}

/**
 * @param {string} songId  酷我歌曲 id（允许带 MUSIC_ 前缀）
 * @param {string} quality 期望音质（320k/flac 先试高码率参数，失败自动回落 128k）
 * @returns {Promise<string|null>}
 */
async function resolveKwUrl(songId, quality = '128k') {
  const id = String(songId || '').replace(/^MUSIC_/i, '').trim();
  if (!/^\d+$/.test(id)) return null;
  const attempts = [];
  if (quality === '320k' || quality === 'flac' || quality === '2000k') {
    attempts.push(`https://antiserver.kuwo.cn/anti.s?type=convert_url&format=mp3&br=320kmp3&response=url&rid=MUSIC_${id}`);
  }
  attempts.push(`https://antiserver.kuwo.cn/anti.s?type=convert_url&format=mp3&response=url&rid=MUSIC_${id}`);
  for (const url of attempts) {
    try {
      const out = await fetchText(url);
      if (out && looksLikeAudioUrl(out)) return out;
    } catch (_) { /* 尝试下一档 */ }
  }
  return null;
}

module.exports = { resolveKwUrl };
