# Ami Helpdesk - TypeScript Production Docker Image
#
# Two stages, unlike the JavaScript build. TypeScript has to be compiled, and the
# compiler plus the @types packages are devDependencies that must NOT ship in the
# runtime image. Splitting the stages means the final image carries only
# production dependencies and the emitted JavaScript.
#
# Cross-platform: this is a Linux container image, so it builds the same way on
# Docker Desktop (Windows/macOS, Linux container mode) and on native Linux.
#
# Build:  docker build -t ami-helpdesk-ts .
# Run:    docker run -p 3000:3000 --env-file .env ami-helpdesk-ts

# ---------------------------------------------------------------------------
# Stage 1: compile TypeScript to JavaScript.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS builder

WORKDIR /app

ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

# Dependencies first, so this layer is cached and only invalidated when the
# lockfile changes, not on every source edit. devDependencies ARE needed here:
# that is where typescript and the @types packages live.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

# Fail the image build on a type error rather than shipping broken JavaScript.
RUN npx tsc -p tsconfig.json

# ---------------------------------------------------------------------------
# Stage 2: runtime. No compiler, no type definitions, no source maps needed.
# ---------------------------------------------------------------------------
FROM node:22-alpine

# tini reaps zombies and forwards SIGTERM so the container stops gracefully
# instead of waiting out the 10s kill timeout.
RUN apk add --no-cache tini

ENV NODE_ENV=production \
    PORT=3000 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

WORKDIR /app

# Unprivileged runtime user; the server never runs as root.
RUN addgroup -g 1001 -S nodejs && \
    adduser -S ami -u 1001 -G nodejs

# Production dependencies only.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled output from the builder, plus the static assets the server serves.
COPY --from=builder --chown=ami:nodejs /app/dist ./dist
COPY --chown=ami:nodejs public ./public

# db/schema.sql is REQUIRED at runtime, not optional. db.ts reads it on startup
# to create the schema, and it does so BEFORE checking whether the schema is
# already present. If this file is missing from the image the read throws, the
# Postgres backend fails to initialise, and the server silently falls back to
# the JSON store - appearing healthy while ignoring every row in Postgres.
COPY --chown=ami:nodejs db ./db

# Real filed tickets used as few-shot examples. Reference data, not runtime
# state, so it lives outside data/ - which .dockerignore excludes - and is
# baked into the image deliberately.
COPY --chown=ami:nodejs rag ./rag

# Writable state directories (overridden by the ami_data volume in compose).
RUN mkdir -p /app/data/conversations \
             /app/data/attachments \
             /app/data/uploads \
             /app/data/rag && \
    chown -R ami:nodejs /app/data

USER ami

EXPOSE 3000

# Healthcheck in Node rather than wget/curl: Alpine ships busybox wget, but
# Debian/Ubuntu-based Node images do not, so a wget check silently breaks when the
# base image changes. The self-signed cert is expected, hence
# rejectUnauthorized:false - this only probes local liveness.
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "require('https').get({host:'127.0.0.1',port:process.env.PORT||3000,path:'/api/health',rejectUnauthorized:false},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server/server.js"]