# ── Stage 1: Install dependencies ─────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci 2>/dev/null || npm install

# ── Stage 2: Production image ───────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app
RUN apk add --no-cache curl

# Copy installed node_modules from build stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./

# Copy TypeScript source — tsx runs it directly (no compile step)
COPY src ./src
COPY tsconfig.json ./

# Health check (ALB pings this)
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

EXPOSE 3000

# tsx executes TypeScript directly — no tsc build step required
CMD ["node_modules/.bin/tsx", "src/server.ts"]
