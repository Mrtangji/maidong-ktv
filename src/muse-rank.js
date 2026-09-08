/**
 * muse.db 排行榜（与安卓端同源）
 * ================================
 * 复刻 maidong app MuseDatabase.kt 的排行查询：
 *   - 排行榜歌单: playlists(type=2, deleted_at IS NULL)
 *   - 歌单歌曲  : songs ⋈ playlist_songs，按 ps.sort_no 排序
 * muse.db 只读打开；文件缺失时 available()=false，接口安全返回空。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SONG_SELECT =
  "SELECT s.id, s.name, s.filename, s.lang, " +
  "COALESCE(NULLIF(s.singer_names,''), " +
  "(SELECT group_concat(sg.name,'、') FROM song_singer_relations ssr " +
  "INNER JOIN singers sg ON sg.id=ssr.singer_id WHERE ssr.song_id=s.id), '') AS singer_names " +
  "FROM songs s ";

class MuseRank {
  constructor(dataDir, musicDir) {
    this.dbPath = path.join(dataDir, 'muse.db');
    this.tsDir = path.join(musicDir, 'ts');
    this._db = null;
  }

  available() { return fs.existsSync(this.dbPath); }

  _open() {
    if (this._db) return this._db;
    if (!this.available()) return null;
    this._db = new DatabaseSync(this.dbPath, { readOnly: true });
    return this._db;
  }

  close() { try { this._db && this._db.close(); } catch (_) {} this._db = null; }

  /** 排行榜歌单：[{id, name, rankType, songCount}] */
  rankPlaylists() {
    const db = this._open();
    if (!db) return [];
    const rows = db.prepare(
      "SELECT id, name, rank_type, song_count FROM playlists " +
      "WHERE deleted_at IS NULL AND type=2 " +
      "ORDER BY CASE WHEN rank_type IS NULL THEN 1 ELSE 0 END, rank_type ASC, rec_score DESC"
    );
    const out = [];
    for (const r of rows.iterate()) {
      out.push({
        id: String(r.id),
        name: r.name || '',
        rankType: r.rank_type == null ? null : Number(r.rank_type),
        songCount: r.song_count == null ? 0 : Number(r.song_count),
      });
    }
    return out;
  }

  /** 歌单歌曲（分页）：[{no, file, title, singer, cached}] */
  rankSongs(playlistId, page = 1, pageSize = 30) {
    const db = this._open();
    if (!db) return { songs: [], total: 0 };
    const totalRow = db.prepare(
      "SELECT COUNT(*) AS c FROM playlist_songs ps INNER JOIN songs s ON s.id=ps.song_id " +
      "WHERE ps.playlist_id=? AND s.deleted_at IS NULL"
    ).get(String(playlistId));
    const total = totalRow ? Number(totalRow.c) : 0;
    const offset = (Math.max(1, page) - 1) * pageSize;
    const rows = db.prepare(
      SONG_SELECT +
      "INNER JOIN playlist_songs ps ON s.id=ps.song_id " +
      "WHERE ps.playlist_id=? AND s.deleted_at IS NULL " +
      "ORDER BY ps.sort_no ASC LIMIT ? OFFSET ?"
    );
    const songs = [];
    for (const r of rows.iterate(String(playlistId), String(pageSize), String(offset))) {
      const file = r.filename || '';
      const no = file.replace(/\.(ls|ts)$/i, '');
      songs.push({
        no,
        file,
        title: r.name || no,
        singer: r.singer_names || '',
        cached: file ? fs.existsSync(path.join(this.tsDir, file)) : false,
      });
    }
    return { songs, total };
  }
}

module.exports = { MuseRank };
