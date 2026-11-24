# Stage 1: Install production dependencies
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@12.18.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Stage 2: Minimal hardened runtime image
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    FORCE_COLOR=1 \
    COLUMNS=110

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json config.js index.js ./
COPY --chown=node:node services ./services

USER node

HEALTHCHECK --interval=60s --timeout=5s --start-period=15s --retries=3 \
  CMD pgrep -f "node index.js" > /dev/null || exit 1

CMD ["node", "index.js"]
