# Site Status: API + PWA in one small image (no npm dependencies at runtime).
# Build from the repo root:  docker build -f api/Dockerfile -t site-status .
FROM node:24-alpine
ENV NODE_ENV=production PORT=8080 WEB_ROOT=/app/web
WORKDIR /app
COPY shared/ ./shared/
COPY api/server.mjs ./api/
COPY web/ ./web/
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "api/server.mjs"]
