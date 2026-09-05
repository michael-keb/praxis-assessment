# ---------- build the React client ----------
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY vite.config.js ./
COPY client ./client
RUN npm run build

# ---------- runtime ----------
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data

# better-sqlite3 normally installs a prebuilt binary; keep a toolchain
# available so it can compile from source if no prebuild matches, then
# drop it again in the same layer to keep the image small.
COPY package*.json ./
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && npm ci --omit=dev \
 && apt-get purge -y python3 make g++ \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

COPY server ./server
COPY --from=build /app/dist ./dist
COPY static ./static

EXPOSE 8124
CMD ["node", "server/index.js"]
