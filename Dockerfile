FROM node:24-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY scripts/build.mjs ./scripts/
COPY src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       texlive-latex-base texlive-latex-recommended texlive-fonts-recommended \
       texlive-xetex texlive-luatex fontconfig fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o node -g node /data

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY server ./server

ENV NODE_ENV=production \
    TEXDESK_HOST=0.0.0.0 \
    TEXDESK_DATA_DIR=/data \
    PORT=4030

USER node
EXPOSE 4030
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "server/index.mjs"]
