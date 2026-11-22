# ---- Stage 1: build the frontend bundle ----
FROM node:20-alpine AS client-build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# ---- Stage 2: runtime image (no build tools, no dev dependencies) ----
FROM node:20-alpine
ENV NODE_ENV=production
# Pull in patched Alpine packages so the image scan has fewer fixable CVEs
RUN apk upgrade --no-cache
WORKDIR /usr/src/app/server
COPY server/package*.json ./
# Install production dependencies, then remove npm, npx, yarn and corepack:
# the app runs with "node server.js", so they are only extra attack surface
RUN npm ci --omit=dev && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
              /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* \
              /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY server/ ./
COPY --from=client-build /app/client/public /usr/src/app/client/public

# Numeric non-root user so Kubernetes can enforce runAsNonRoot
RUN addgroup -S -g 10001 appgroup && adduser -S -u 10001 -G appgroup appuser \
    && chown -R appuser:appgroup /usr/src/app
USER 10001

EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:5000/healthz || exit 1
CMD ["node", "server.js"]
