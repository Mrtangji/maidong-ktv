'use strict';
/**
 * MV .ts → HLS 转封装缓存（骏耀同思路，简化版）。
 * 网页端 <video> 无法直接播 MPEG-TS，用 ffmpeg -c copy 纯转封装成
 * HLS（m3u8 + ts 分片，不重编码，秒级完成），前端 hls.js 播放，
 * 天然支持 Range/seek。缓存到 HLS_DIR/<no>/index.m3u8，永久复用。
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

class HlsCache {
  constructor(hlsDir) {
    this.hlsDir = hlsDir;
    this.inflight = new Map(); // no -> Promise<playlistPath>
  }

  /** 确保 HLS 已生成；已有缓存秒回，转封装中则共用同一 Promise。 */
  ensure(sourcePath, no) {
    const outDir = path.join(this.hlsDir, no);
    const playlist = path.join(outDir, 'index.m3u8');
    if (fs.existsSync(playlist) && fs.statSync(playlist).size > 0) return Promise.resolve(playlist);
    if (this.inflight.has(no)) return this.inflight.get(no);
    const p = this._transmux(sourcePath, outDir, playlist)
      .finally(() => this.inflight.delete(no));
    this.inflight.set(no, p);
    return p;
  }

  _transmux(sourcePath, outDir, playlist) {
    fs.mkdirSync(outDir, { recursive: true });
    // 清掉上次可能中断的半成品
    for (const f of fs.readdirSync(outDir)) {
      try { fs.unlinkSync(path.join(outDir, f)); } catch (_) {}
    }
    return new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-i', sourcePath,
        '-c', 'copy',                      // 纯转封装，不重编码
        '-f', 'hls',
        '-hls_time', '6',
        '-hls_list_size', '0',
        '-hls_segment_type', 'mpegts',
        '-hls_segment_filename', path.join(outDir, 'seg%04d.ts'),
        playlist,
      ]);
      let err = '';
      ff.stderr.on('data', (c) => { if (err.length < 4000) err += c; });
      ff.on('error', (e) => reject(new Error('ffmpeg 不可用: ' + e.message)));
      ff.on('close', (code) => {
        if (code === 0 && fs.existsSync(playlist) && fs.statSync(playlist).size > 0) resolve(playlist);
        else reject(new Error('ffmpeg 退出 ' + code + ': ' + err.slice(-200)));
      });
    });
  }

  /** 分片文件路径（防目录穿越），非法返回 null。 */
  segmentPath(no, seg) {
    if (!/^[\w-]+$/.test(no) || !/^[\w.-]+\.ts$/i.test(seg)) return null;
    const p = path.join(this.hlsDir, no, seg);
    return fs.existsSync(p) ? p : null;
  }
}

module.exports = { HlsCache };
