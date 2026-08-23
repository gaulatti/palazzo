# Palazzo Docker image
#
# Bundles Node.js (NestJS API), Liquidsoap (audio engine),
# and Icecast2 (streaming server) into a single container.
#
# Ports:
#   3100 — NestJS REST API
#   8000 — Icecast2 MP3 stream

FROM node:22.22.0-trixie-slim@sha256:465a8c8f0f4103861bcbcf3e512608394b7155eccb1955425f4ea3f672ddc53e AS node-runtime

FROM savonet/liquidsoap:v2.4.5@sha256:206664046c8cd012151928a6ea903a6ab65c20295b84c0891b33b93fbf5a8f24

USER root

COPY --from=node-runtime /usr/local/ /usr/local/

WORKDIR /app

# Liquidsoap and Node come from exact multi-architecture image digests. Install
# only the companion daemons and tools needed by the combined runtime.
RUN mkdir -p /var/lib/apt/lists/partial \
  && apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  lame \
  icecast2 \
  && liquidsoap --version \
  && node --version \
  && rm -rf /var/lib/apt/lists/*

# Install Node.js dependencies first for better layer caching.
COPY package*.json ./
RUN npm ci && npm cache clean --force

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
