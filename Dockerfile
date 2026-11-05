# Builds OnicaiBot, with the vendored SDK:
#   docker build -t onicai-bot .
FROM node:22-alpine AS build
WORKDIR /src

# The dependencies first, so that their install is cached while the bot changes
COPY package.json package-lock.json ./
COPY vendor/ vendor/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production PORT=3200 DATA_FILE=/data/games.json APP_DIR=/app/dist/app
WORKDIR /app
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules/ node_modules/
COPY --from=build /src/dist/ dist/
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3200
CMD ["node", "dist/server/server.js"]
