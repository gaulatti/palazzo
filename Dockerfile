FROM node:22

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
  liquidsoap \
  lame \
  icecast2 \
  ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install && npm cache clean --force

COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src/ ./src/

RUN npm run build

COPY docker-entrypoint.sh \
     ./

RUN chmod +x /app/docker-entrypoint.sh

EXPOSE 3100 8000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
