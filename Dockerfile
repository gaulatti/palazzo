# Palazzo Docker image
#
# Bundles Node.js (NestJS API), Liquidsoap (audio engine),
# and Icecast2 (streaming server) into a single container.
#
# Ports:
#   3100 — NestJS REST API
#   8000 — Icecast2 MP3 stream

FROM node:22

WORKDIR /app

# Install system-level dependencies: audio tools and Icecast.
RUN apt-get update && apt-get install -y --no-install-recommends \
  liquidsoap \
  lame \
  icecast2 \
  ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install Node.js dependencies first for better layer caching.
COPY package*.json ./
RUN npm install && npm cache clean --force

# Copy TypeScript source and compile.
COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
RUN npm run build

# Entrypoint script that generates Icecast config and starts services.
COPY docker-entrypoint.sh ./
RUN chmod +x /app/docker-entrypoint.sh

EXPOSE 3100 8000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
