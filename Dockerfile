FROM node:22 AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
  liquidsoap \
  lame \
  ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src/ ./src/

RUN npm run build

FROM node:22-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
  liquidsoap \
  lame \
  ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package*.json ./

EXPOSE 3100

CMD ["node", "dist/src/main.js"]
