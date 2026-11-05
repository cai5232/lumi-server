FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
RUN addgroup -S -g 1001 mcpkey && addgroup node mcpkey
USER node
EXPOSE 8788
CMD ["node", "src/index.js"]
