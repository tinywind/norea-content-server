FROM node:24-bookworm-slim
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY src ./src
RUN mkdir /data && chown node:node /data
USER node
ENV NOREA_HOST=0.0.0.0 NOREA_PORT=8787 NOREA_DATA_DIR=/data
EXPOSE 8787
CMD ["node", "src/main.ts"]
