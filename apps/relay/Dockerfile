FROM oven/bun:1.3 AS builder

WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/ packages/
COPY apps/relay/ apps/relay/

RUN bun install --frozen-lockfile
RUN bun build apps/relay/src/index.ts --compile --outfile /app/tp-relay

FROM gcr.io/distroless/cc-debian12
COPY --from=builder /app/tp-relay /tp-relay
EXPOSE 7090
ENTRYPOINT ["/tp-relay"]
