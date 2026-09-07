# 麦动KTV 服务端（maidong-ktv-server）

把 maidong-ktv 从「单机安卓 App」升级为与 junyao-ktv 相同的**三层架构**：

```
┌─────────────────────────────────────────────┐
│                NAS (docker)                  │
│  ┌─────────────────────────────────────┐    │
│  │  maidong-ktv-server  (Node, :8080)  │    │
│  │  · 酷我搜索/歌词/榜单（内置）         │    │
│  │  · LX 沙箱音源脚本（解析播放链接）     │    │
│  │  · 曲库全量缓存  →  /music 卷        │    │
│  │  · 音源脚本/索引  →  /data 卷        │    │
│  │  · UDP 18888 局域网自动发现          │    │
│  └──────────┬──────────────┬───────────┘    │
└─────────────┼──────────────┼────────────────┘
              │              │
      ┌───────▼──────┐  ┌────▼─────────────┐
      │   电视端      │  │   手机端          │
      │ /tv 或安卓APK │  │  /m  H5 点歌     │
      └──────────────┘  └──────────────────┘
```

## 目录结构

```
maidong-server/
├── server.js               # HTTP 服务 + 路由 + 流播放 + UDP 发现
├── src/
│   ├── lx-sandbox.js       # LX 音源脚本沙箱（Node 移植自 maidong WebView 沙箱）
│   ├── kw.js               # 酷我搜索/歌词/点唱榜（移植自 KwSource.kt）
│   ├── cache.js            # 曲库缓存管理（/music 全量缓存 + JSON 索引）
│   └── queue.js            # 共享点歌队列（手机加歌 → 电视播放）
├── web/
│   ├── tv/index.html       # 电视端大屏 UI（遥控器方向键操作）
│   └── m/index.html        # 手机端 H5（搜索/点歌/曲库/音源导入）
├── android-tv/             # 安卓电视端 APK（WebView 壳 + 局域网发现）
├── Dockerfile / docker-compose.yml / docker-compose.nas.yml
└── .github/workflows/docker-publish.yml   # 多架构镜像自动发布
```

## API 一览（/api/v1）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /health | 健康检查（`ready` = 音源是否就绪） |
| GET | /sources | 音源列表（内置酷我 + LX 脚本声明） |
| POST | /lx/import | 导入 LX 音源脚本（`{script}` 或直接 POST 文本） |
| GET/DELETE | /lx/current | 查看/移除当前音源脚本 |
| GET | /search?keyword= | 酷我搜索 |
| GET | /board · /board/songs?id= | 酷我榜单（KTV点唱榜等 15 个） |
| GET | /lyric?songId= | 酷我歌词（LRC） |
| GET | /song/url?songId= | 解析播放直链（**同时自动缓存到 NAS**） |
| GET | /stream?songId= | 播放流：命中缓存播本地文件，否则 302 直链 |
| GET | /library · POST /library/cache · DELETE /library/:songId | 曲库列表 / 批量缓存 / 删除 |
| GET | /queue · POST /queue · POST /queue/played | 共享点歌队列 |

## 曲库缓存机制

- **自动缓存**：任何一首歌被播放（电视端 `/stream`、`/song/url`），后台自动下载到
  `/music/歌手 - 歌名.mp3`，同时落地同名 `.lrc` 歌词（命名对齐 maidong App）。
- **批量缓存**：手机端「曲库」页可一键把「KTV点唱榜」整榜加入缓存队列（并发 2、失败记录、重启不丢队列外已缓存文件）。
- 索引 `library-index.json` 原子写入 `/data`；文件用 `.part` 临时名下载、完成后改名，不会产生半截文件。

## 部署

见 [docs/NAS部署指南.md](docs/NAS部署指南.md)。最短路径（NAS SSH）：

```bash
mkdir -p /vol1/1000/docker/maidong-ktv/{music,data}
cd /vol1/1000/docker/maidong-ktv
# 下载 docker-compose.nas.yml 后:
docker compose -f docker-compose.nas.yml up -d
```

电视端浏览器/APK 打开 `http://NAS_IP:8080/tv`，手机打开 `http://NAS_IP:8080/m`。

## 首次使用

1. 手机打开 `/m` → 「音源」页 → 粘贴 LX（洛雪）自定义音源脚本 `.js` 全文 → 导入。
2. 导入成功后「搜索」页即可搜歌点歌；电视端自动开始播放队列。
3. 播放过的歌都会沉淀进 NAS 曲库，之后播放直接走本地文件（秒开、可拖进度）。
