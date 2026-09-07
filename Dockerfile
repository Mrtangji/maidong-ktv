# maidong-ktv-server —— 零依赖，Node 22 即可
FROM node:22-alpine

WORKDIR /app

# 全部源码与 Web UI（无 npm install —— 无第三方依赖）
COPY server.js ./
COPY src ./src
COPY web ./web

# 曲库与数据目录（docker volume / NAS bind mount 挂载点）
RUN mkdir -p /music /data

ENV PORT=8080 \
    DISCOVERY_PORT=18888 \
    MUSIC_DIR=/music \
    DATA_DIR=/data \
    NODE_ENV=production

EXPOSE 8080
EXPOSE 18888/udp

VOLUME ["/music", "/data"]

CMD ["node", "server.js"]
