# NAS 部署指南（飞牛 / 群晖 / 通用 Docker）

## 前置要求

- NAS 已安装 Docker / Container Manager
- NAS 与电视盒子、手机在同一局域网

## 一、准备目录

SSH 登录 NAS（飞牛示例路径，其他 NAS 自行调整）：

```bash
mkdir -p /vol1/1000/docker/maidong-ktv/music
mkdir -p /vol1/1000/docker/maidong-ktv/data
cd /vol1/1000/docker/maidong-ktv
```

## 二、拉起服务

方式 A —— 用预构建镜像（推荐，需先在 GitHub push 触发 docker-publish 工作流）：

```bash
curl -O https://raw.githubusercontent.com/<你的用户名>/maidong-ktv-server/master/docker-compose.nas.yml
docker compose -f docker-compose.nas.yml up -d
```

方式 B —— 本地构建（把整个 maidong-server 目录上传到 NAS 后）：

```bash
cd maidong-server
docker build -t maidong-ktv-server:latest .
docker run -d --name maidong-ktv --restart unless-stopped \
  --network host \
  -v /vol1/1000/docker/maidong-ktv/music:/music \
  -v /vol1/1000/docker/maidong-ktv/data:/data \
  maidong-ktv-server:latest
```

> 零 npm 依赖，镜像只有 node:22-alpine 基底（~80MB），amd64 / arm64 都能跑。

## 三、验证

```bash
curl http://127.0.0.1:8080/api/v1/health
# {"app":"maidong-ktv-server","version":"1.0.0","ready":false}
```

## 四、导入音源

1. 手机浏览器打开 `http://NAS_IP:8080/m`
2. 底部「🎵 音源」→ 粘贴 LX（洛雪）音源脚本全文 → 导入
3. 提示导入成功、列出支持平台即完成（脚本持久化在 `/data/lx/script.js`，重启自动恢复）

## 五、使用

- **电视端**：电视盒子浏览器打开 `http://NAS_IP:8080/tv`，或安装 `android-tv/` 里的 APK（自动扫描发现服务）
- **手机点歌**：`http://NAS_IP:8080/m` 搜索 → 点歌 → 电视自动播放
- **曲库全量缓存**：手机 `/m` →「💾 曲库」→「缓存 KTV点唱榜全部到 NAS」；平时播放过的歌也会自动入库

## 六、运维

```bash
docker logs -f maidong-ktv          # 看日志
docker compose -f docker-compose.nas.yml pull && \
docker compose -f docker-compose.nas.yml up -d   # 升级
```

- 备份 = 备份 `data/`（音源脚本 + 索引）与 `music/`（曲库本体）
- 缓存的文件命名「歌手 - 歌名.ext」，可直接被其他播放器/NAS 媒体库扫描

## 常见问题

| 现象 | 处理 |
|---|---|
| 电视端显示「未导入音源脚本」 | 手机 `/m` → 音源页导入 LX 脚本 |
| 搜索有结果但播放失败 | LX 脚本对应平台链接失效，换一个音源脚本 |
| UDP 发现不生效（APK 扫不到） | compose 未用 host 网络时需放开 `18888/udp` 映射；或电视端手动输入 `NAS_IP:8080` |
| NAS 路径不同 | 修改 compose 里两个卷的左侧路径即可 |
