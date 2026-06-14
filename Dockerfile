# ─── Stage 1: Base ───────────────────────────────────────────────────────────
FROM node:20-alpine AS base
WORKDIR /app

FROM base AS pnpm-base
RUN npm i -g pnpm@10.28.2

# ─── Stage 2: All Dependencies (for building) ────────────────────────────────
FROM pnpm-base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ─── Stage 3: Prod Dependencies Only (for running) ───────────────────────────
FROM pnpm-base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# ─── Stage 4: Builder ────────────────────────────────────────────────────────
FROM pnpm-base AS builder

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm run build

# ─── Stage 5: Production Runner ──────────────────────────────────────────────
FROM base AS runner

# ✅ Fix 1 — added --ingroup nodejs
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 --ingroup nodejs nestjs

# ✅ Change ownership and mode
RUN chown nestjs:nodejs /app \
 && chmod 750 /app

COPY --chown=nestjs:nodejs --from=prod-deps /app/node_modules ./node_modules
COPY --chown=nestjs:nodejs --from=builder   /app/dist         ./dist

USER nestjs



CMD ["node", "dist/main"]