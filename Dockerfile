FROM node:20-alpine

WORKDIR /app

# dependências primeiro (cache de camadas)
COPY server/package.json ./server/
RUN cd server && npm install --omit=dev

COPY server/ ./server/
COPY client/ ./client/

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

RUN mkdir -p /data

EXPOSE 3000

VOLUME ["/data"]

CMD ["node", "server/index.js"]
