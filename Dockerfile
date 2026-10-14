FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.web.json ./
COPY web ./web
RUN pnpm build && pnpm prune --prod

FROM node:24-bookworm-slim
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/webdist ./webdist
COPY --from=build /app/web ./web
COPY package.json ./
COPY src ./src
RUN mkdir -p /data/contents /data/staging && chown -R node:node /data
USER node
ENV NOREA_HOST=0.0.0.0 NOREA_PORT=8787 NOREA_DATA_DIR=/data
EXPOSE 8787
CMD ["node", "src/main.ts"]
