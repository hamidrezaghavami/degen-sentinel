FROM node:22-alpine

WORKDIR /app

# Enable pnpm via corepack matching package.json packageManager
RUN corepack enable && corepack prepare pnpm@12.18.0 --activate

# Install production dependencies using lockfile cache layer
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Copy application source
COPY config.js index.js ./
COPY services ./services

# Run as non-root user
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
ENV FORCE_COLOR=1

CMD ["node", "index.js"]
