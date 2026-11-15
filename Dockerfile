FROM node:24-alpine
WORKDIR /app
COPY package.json server.mjs cli.mjs ./
COPY src ./src
COPY public ./public
# 版本号 = 建置日期（北京时间）
RUN date -u -d "@$(( $(date +%s) + 28800 ))" +%Y%m%d > VERSION
ENV NODE_ENV=production DATA_DIR=/data PORT=8787 HOST=0.0.0.0
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "server.mjs"]
