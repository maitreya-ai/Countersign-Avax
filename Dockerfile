# Countersign node + demo sellers in one process (one port). Needs a persistent volume at /data.
FROM oven/bun:1.4
WORKDIR /app
COPY package.json bun.lock ./
COPY packages ./packages
COPY services ./services
COPY demo ./demo
COPY web/package.json ./web/package.json
RUN bun install --production
COPY deployments ./deployments
ENV NODE_DB=/data/node.db \
    MOUNT_SELLERS=1
EXPOSE 8080
CMD ["bun", "run", "services/node/src/index.ts"]
