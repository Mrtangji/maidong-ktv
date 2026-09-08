'use strict';
/**
 * 共享点歌队列 —— 手机端加歌、电视端播放。
 * 持久化到 dataDir/queue.json，服务重启不丢。
 */

const fs = require('fs');
const path = require('path');

class SongQueue {
  constructor(dataDir) {
    this.filePath = path.join(dataDir, 'queue.json');
    this.items = [];
    this.history = [];
    this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.items = Array.isArray(raw.items) ? raw.items : [];
      this.history = Array.isArray(raw.history) ? raw.history : [];
    } catch (_) { /* ignore */ }
  }

  _save() {
    const payload = JSON.stringify({ items: this.items, history: this.history.slice(-100) });
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  add(song) {
    if (!song || !song.songId) return null;
    if (this.items.some((s) => s.songId === song.songId)) return null;
    const item = {
      songId: song.songId,
      title: song.title || '',
      singer: song.singer || '',
      album: song.album || '',
      pic: song.pic || '',
      quality: song.quality || '128k',
      musicInfo: song.musicInfo || null,
      videoUrl: song.videoUrl || null,   // 服务器 MV（HLS），网页端 hls.js 播放
      addedAt: new Date().toISOString(),
    };
    this.items.push(item);
    this._save();
    return item;
  }

  list() { return this.items; }
  getHistory() { return this.history; }

  current() { return this.items[0] || null; }

  /** 标记当前这首歌播放完成（电视端播完调用）。 */
  played(index = 0) {
    if (index !== 0) {
      const [item] = this.items.splice(index, 1);
      if (item) { this.history.push({ ...item, playedAt: new Date().toISOString() }); this._save(); }
      return item || null;
    }
    const item = this.items.shift();
    if (item) { this.history.push({ ...item, playedAt: new Date().toISOString() }); this._save(); }
    return item || null;
  }

  remove(index) {
    const [item] = this.items.splice(Number(index), 1);
    if (item) this._save();
    return item || null;
  }

  clear() {
    const n = this.items.length;
    this.items = [];
    this._save();
    return n;
  }
}

module.exports = { SongQueue };
