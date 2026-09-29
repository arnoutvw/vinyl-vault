# Vinyl Vault — intentionally insecure training app
FROM node:20-bookworm-slim

# Build tools in case a prebuilt better-sqlite3 binary is unavailable.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

# Data volume so the SQLite DB survives restarts.
ENV VV_DATA_DIR=/app/data
VOLUME ["/app/data"]

EXPOSE 3000
CMD ["node", "server.js"]
