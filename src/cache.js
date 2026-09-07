'use strict';
/**
 * 曲库缓存管理器 —— 把解析出的歌曲落地到 NAS 卷（/music），全量缓存。
 *
 * 对齐 maidong-ktv OnlineSongDownloader 的落盘命名：
 *   「歌手 - 歌名.ext」 + 同名 .lrc 歌词
 * 索引存 dataDir/library-index.json（原子写入），支持：
 *   - 播放时自动缓存（fire-and-forget）
 *   - 批量缓存（并发 2、可暂停、失败重试）
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const DOWNLOAD_CONCURRENCY = 2;

function sanitizeName(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|\r\n]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function urlExtension(url) {
  try {
    const pathname = new URL(url).pathname;
    const m = pathname.match(/\.([a-z0-9]{2,5})$/i);
    if (m) {
      const ext = m[1].toLowerCase();
      if (['mp3', 'flac', 'm4a', 'aac', 'ogg', 'wav', 'ape', 'wma', 'mp4', 'mkv'].includes(ext)) return ext;
    }
  } catch (_) { /* ignore */ }
  return 'mp3';
}

class LibraryCache {
  /**
   * @param dataDir   /data（索引、状态）
   * @param musicDir  /music（曲库文件）
   * @param deps      { resolveMusicUrl(musicInfo, quality) => Promise<url|null>, fetchLyric(songId) => Promise<string> }
   */
  constructor(dataDir, musicDir, deps) {
    this.dataDir = dataDir;
    this.musicDir = musicDir;
    this.resolveMusicUrl = deps.resolveMusicUrl;
    this.fetchLyric = deps.fetchLyric;
    this.indexPath = path.join(dataDir, 'library-index.json');
    this.songs = {};       // songId -> {songId,title,singer,quality,file,lrc,size,cachedAt}
    this.pending = [];     // 待缓存队列
    this.activeSongs = new Set(); // 正在下载中的 songId（防止与代理缓存并发重复落盘）
    this.active = 0;       // 当前并发
    this.failed = {};      // songId -> 最近失败原因
    this.stopped = false;
    this._load();
    fs.mkdirSync(this.musicDir, { recursive: true });
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
      this.songs = raw.songs && typeof raw.songs === 'object' ? raw.songs : {};
    } catch (_) {
      this.songs = {};
    }
  }

  _save() {
    const payload = JSON.stringify({ version: 1, savedAt: new Date().toISOString(), songs: this.songs }, null, 2);
    const tmp = this.indexPath + '.tmp';
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, this.indexPath);
  }

  has(songId) {
    const song = this.songs[songId];
    if (!song) return false;
    return fs.existsSync(path.join(this.musicDir, song.file));
  }

  list() {
    return Object.values(this.songs)
      .filter((s) => fs.existsSync(path.join(this.musicDir, s.file)))
      .sort((a, b) => (b.cachedAt || '').localeCompare(a.cachedAt || ''));
  }

  findByFile(file) {
    return Object.values(this.songs).find((s) => s.file === file) || null;
  }

  /**
   * 等待下载中的歌曲落盘，避免两条下载链路并发写同一文件。
   * 返回 'cached'（已入曲库）| 'idle'（没有在下载，可走代理解析）| 'busy'（等待超时）。
   */
  async waitUntilCached(songId, timeoutMs = 120_000) {
    const isInflight = () => this.activeSongs.has(songId) || this.pending.some((p) => p.songId === songId);
    const deadline = Date.now() + timeoutMs;
    while (isInflight()) {
      if (this.has(songId)) return 'cached';
      if (Date.now() > deadline) return 'busy';
      await new Promise((r) => setTimeout(r, 500));
    }
    return this.has(songId) ? 'cached' : 'idle';
  }

  /** 播放后自动缓存：已存在/正在下载/已在队列则跳过，失败静默（不影响播放）。 */
  autoCache(song) {
    if (!song || !song.songId) return;
    if (this.has(song.songId) || this.activeSongs.has(song.songId) ||
        this.pending.some((p) => p.songId === song.songId)) return;
    this.pending.push({ ...song, reason: 'auto' });
    this._pump();
  }

  /** 批量入队；返回实际新增数量。 */
  batchCache(songs) {
    let added = 0;
    (Array.isArray(songs) ? songs : [songs]).forEach((song) => {
      if (!song || !song.songId) return;
      if (this.has(song.songId) || this.activeSongs.has(song.songId) ||
          this.pending.some((p) => p.songId === song.songId)) return;
      this.pending.push({ ...song, reason: 'batch' });
      added += 1;
    });
    this._pump();
    return added;
  }

  clearPending() {
    const n = this.pending.length;
    this.pending = [];
    return n;
  }

  status() {
    return {
      cached: Object.keys(this.songs).length,
      pending: this.pending.length,
      active: this.active,
      failedCount: Object.keys(this.failed).length,
      recentFailed: Object.entries(this.failed).slice(-5).map(([songId, reason]) => ({ songId, reason })),
    };
  }

  _pump() {
    while (this.active < DOWNLOAD_CONCURRENCY && this.pending.length > 0 && !this.stopped) {
      const job = this.pending.shift();
      this.active += 1;
      this.activeSongs.add(job.songId);
      this._download(job)
        .catch((err) => {
          this.failed[job.songId] = String(err && err.message || err);
        })
        .finally(() => {
          this.active -= 1;
          this.activeSongs.delete(job.songId);
          setImmediate(() => this._pump());
        });
    }
  }

  async _download(song) {
    const url = await this.resolveMusicUrl(song.musicInfo || song, song.quality || '128k');
    if (!url) throw new Error('解析失败：无可用音源链接');

    const base = `${sanitizeName(song.singer || '未知歌手')} - ${sanitizeName(song.title || song.songId)}`;
    const ext = urlExtension(url);
    const file = this._uniqueFile(`${base}.${ext}`);

    // 歌词尽力而为
    let lrcText = null;
    try { lrcText = await this.fetchLyric(song.songId); } catch (_) { /* ignore */ }

    await this._fetchToFile(url, path.join(this.musicDir, file));

    if (lrcText) {
      try { fs.writeFileSync(path.join(this.musicDir, `${base}.lrc`), lrcText, 'utf8'); } catch (_) { /* ignore */ }
    }

    const stat = fs.statSync(path.join(this.musicDir, file));
    this.songs[song.songId] = {
      songId: song.songId,
      title: song.title || '',
      singer: song.singer || '',
      album: song.album || '',
      pic: song.pic || '',
      quality: song.quality || '128k',
      file,
      lrc: lrcText ? `${base}.lrc` : null,
      size: stat.size,
      cachedAt: new Date().toISOString(),
    };
    delete this.failed[song.songId];
    this._save();
  }

  _uniqueFile(name) {
    let candidate = name;
    let i = 1;
    while (fs.existsSync(path.join(this.musicDir, candidate))) {
      const ext = path.extname(name);
      const stem = name.slice(0, name.length - ext.length);
      candidate = `${stem} (${i})${ext}`;
      i += 1;
    }
    return candidate;
  }

  _fetchToFile(url, target) {
    return new Promise((resolve, reject) => {
      const doGet = (targetUrl, redirectsLeft) => {
        let target_;
        try { target_ = new URL(targetUrl); } catch (e) { return reject(new Error('invalid url')); }
        const lib = target_.protocol === 'https:' ? https : http;
        const req = lib.request({
          hostname: target_.hostname,
          port: target_.port || (target_.protocol === 'https:' ? 443 : 80),
          path: target_.pathname + target_.search,
          method: 'GET',
          headers: {
            'User-Agent': 'MaidongKTV/1.0',
            ...(redirectsLeft < 5 ? { Referer: target_.origin } : {}),
          },
          timeout: 30_000,
        }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
            res.resume();
            let next;
            try { next = new URL(res.headers.location, target_).toString(); } catch (_) { return reject(new Error('bad redirect')); }
            return doGet(next, redirectsLeft - 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`下载 HTTP ${res.statusCode}`));
          }
          const partial = `${target}.part`;
          const out = fs.createWriteStream(partial);
          res.pipe(out);
          out.on('finish', () => {
            out.close(() => {
              try {
                fs.renameSync(partial, target);
                resolve();
              } catch (e) { reject(e); }
            });
          });
          out.on('error', reject);
          res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('download timeout')));
        req.on('error', reject);
        req.end();
      };
      doGet(url, 5);
    });
  }

  /** 依据歌曲元数据与直链，得出最终落盘文件名与歌词文件名。 */
  targetsFor(song, url) {
    const base = `${sanitizeName(song.singer || '未知歌手')} - ${sanitizeName(song.title || song.songId)}`;
    return { file: `${base}.${urlExtension(url)}`, lrcFile: `${base}.lrc` };
  }

  /** 代理缓存完成后登记索引（文件已由调用方落盘；lrcText 可选）。 */
  registerFile(song, file, lrcText) {
    try {
      if (lrcText) {
        try { fs.writeFileSync(path.join(this.musicDir, `${file.replace(/\.[^.]+$/, '')}.lrc`), lrcText, 'utf8'); } catch (_) { /* ignore */ }
      }
      const abs = path.join(this.musicDir, file);
      const stat = fs.statSync(abs);
      const lrcName = `${file.replace(/\.[^.]+$/, '')}.lrc`;
      this.songs[song.songId] = {
        songId: song.songId,
        title: song.title || '',
        singer: song.singer || '',
        album: song.album || '',
        pic: song.pic || '',
        quality: song.quality || '128k',
        file,
        lrc: lrcText && fs.existsSync(path.join(this.musicDir, lrcName)) ? lrcName : null,
        size: stat.size,
        cachedAt: new Date().toISOString(),
      };
      delete this.failed[song.songId];
      this._save();
    } catch (e) {
      console.error('[cache] registerFile 失败:', e.message);
    }
  }

  remove(songId) {
    const song = this.songs[songId];
    if (!song) return false;
    [song.file, song.lrc].forEach((f) => {
      if (!f) return;
      try { fs.unlinkSync(path.join(this.musicDir, f)); } catch (_) { /* ignore */ }
    });
    delete this.songs[songId];
    this._save();
    return true;
  }
}

module.exports = { LibraryCache, sanitizeName, urlExtension };
