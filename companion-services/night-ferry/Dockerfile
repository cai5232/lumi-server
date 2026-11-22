FROM node:22-bookworm-slim
WORKDIR /opt/night-ferry
COPY upstream/ ./
RUN npm install --omit=dev --omit=optional --ignore-scripts
COPY http.cjs ./http.cjs
ENV NODE_ENV=production NIGHT_FERRY_DATA=/data NIGHT_FERRY_LLM=none NIGHT_FERRY_READER=言言 NIGHT_FERRY_PRONOUN=她 TZ=Asia/Shanghai
USER node
CMD ["node", "http.cjs"]
