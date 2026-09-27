# ─── CryptoWall — Dockerfile ──────────────────────────────────────────
# Multi-stage build: compile TypeScript → minimal production image

# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install deps first (layer-cached unless package files change)
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Copy source and compile
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Stage 2: Production image ─────────────────────────────────────────────────
FROM node:20-alpine AS runner

# Non-root user for security
RUN addgroup -S cryptowall && adduser -S cryptowall -G cryptowall

WORKDIR /app

# Copy only production artifacts
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder /app/dist ./dist

USER cryptowall

# Expose proxy port
EXPOSE 8545

# Health check — hits /health endpoint
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:8545/health || exit 1

CMD ["node", "dist/server.js"]
