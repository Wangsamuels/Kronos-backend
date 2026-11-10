# One image for both Heroku process types (web + worker). Foundry and Slither are system binaries,
# which is why this deploys on the Heroku container stack.
FROM node:20-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates python3 python3-pip unzip tar \
  && rm -rf /var/lib/apt/lists/*
# Foundry (forge, anvil, cast)
ENV FOUNDRY_DIR=/opt/foundry PATH=/opt/foundry/bin:$PATH
RUN curl -L https://foundry.paradigm.xyz | bash && foundryup --install stable
# Slither (optional analysis input)
RUN pip3 install --no-cache-dir --break-system-packages slither-analyzer==0.10.4 solc-select \
  && solc-select install 0.8.24 && solc-select use 0.8.24

FROM base AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json drizzle.config.ts ./
COPY api ./api
COPY worker ./worker
COPY lib ./lib
COPY db ./db
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production WORKDIR=/tmp/kronos-work
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY contracts ./contracts
# Pre-fetch solc and compile once so analysis runs offline and fast
RUN cd contracts && forge build && rm -rf cache
CMD ["node", "dist/api/server.js"]
