# wasla-whatsapp-server — production image
# Node 22 on current stable Debian; non-root; persistent auth volume;
# healthcheck; graceful signal handling.

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    AUTH_SESSIONS_DIR=/app/auth_sessions

# Runtime deps only (git/python toolchain not needed at runtime; baileys
# ships prebuilt crypto for linux x64/arm64).
WORKDIR /app

# Dependency manifest first for layer caching. package-lock.json is
# authoritative (npm ci).
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --no-audit --no-fund

# Application code
COPY index.js whatsapp.js sessionStore.js rateLimiter.js uuid.js ./

# Persistent session state (host mount REQUIRED in production compose)
RUN mkdir -p /app/auth_sessions && chown -R node:node /app
VOLUME ["/app/auth_sessions"]

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "index.js"]
