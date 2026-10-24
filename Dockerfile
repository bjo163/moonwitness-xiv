FROM node:22-bookworm-slim AS build

RUN apt-get update \
    && apt-get install --yes --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@11 --activate
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/docs/package.json ./apps/docs/package.json
COPY apps/board/package.json ./apps/board/package.json
COPY apps/ui-catalog/package.json ./apps/ui-catalog/package.json
COPY packages/assets/package.json ./packages/assets/package.json
COPY packages/auth/package.json ./packages/auth/package.json
COPY packages/client/package.json ./packages/client/package.json
COPY packages/corpus/package.json ./packages/corpus/package.json
COPY packages/eslint-config/package.json ./packages/eslint-config/package.json
COPY packages/jobs/package.json ./packages/jobs/package.json
COPY packages/knowledge/package.json ./packages/knowledge/package.json
COPY packages/local-ai/package.json ./packages/local-ai/package.json
COPY packages/logger/package.json ./packages/logger/package.json
COPY packages/orm-base/package.json ./packages/orm-base/package.json
COPY packages/orm-integration/package.json ./packages/orm-integration/package.json
COPY packages/orm-knowledge/package.json ./packages/orm-knowledge/package.json
COPY packages/orm-notification/package.json ./packages/orm-notification/package.json
COPY packages/orm-organization/package.json ./packages/orm-organization/package.json
COPY packages/orm/package.json ./packages/orm/package.json
COPY packages/orm-request/package.json ./packages/orm-request/package.json
COPY packages/orm-storage/package.json ./packages/orm-storage/package.json
COPY packages/research/package.json ./packages/research/package.json
COPY packages/types/package.json ./packages/types/package.json
COPY packages/ui/package.json ./packages/ui/package.json
COPY packages/orm-workflow/package.json ./packages/orm-workflow/package.json
RUN --mount=type=cache,id=moonwitness-pnpm-store,target=/root/.local/share/pnpm/store/v11 \
    pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM build AS api-deploy
RUN pnpm --filter @moonwitness/api deploy --prod --legacy /deploy/api \
    && node scripts/prepare-api-runtime-assets.mjs /deploy/api

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    API_PORT=3000 \
    LOG_TO_FILE=false \
    LOG_PRETTY=false
RUN apt-get update \
    && apt-get upgrade --yes \
    && apt-get install --yes --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=api-deploy --chown=node:node /deploy/api ./
RUN mkdir -p /var/lib/moonwitness/attachments && chown node:node /var/lib/moonwitness/attachments
COPY --from=build --chown=node:node /workspace/corpus ./corpus
ENV MOONWITNESS_CORPUS_ROOT=/app/corpus
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/readyz').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/server.js"]

FROM build AS board-build
ARG NEXT_PUBLIC_SITE_URL
ENV BOARD_API_TARGET=http://api:3000 \
    NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL}
RUN pnpm --filter @moonwitness/board build \
    && pnpm board:budget

FROM node:22-bookworm-slim AS board-runtime
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=8080
WORKDIR /app
COPY --from=board-build --chown=node:node /workspace/apps/board/.next/standalone ./
COPY --from=board-build --chown=node:node /workspace/apps/board/.next/static ./apps/board/.next/static
COPY --from=board-build --chown=node:node /workspace/apps/board/public ./apps/board/public
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "apps/board/server.js"]


FROM runtime AS api
