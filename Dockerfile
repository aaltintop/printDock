# syntax=docker/dockerfile:1.7

# ---- 1) Full deps for the React Router build (devDependencies included) ----
# Cached independently of source changes — invalidated only when package*.json
# changes. With Kaniko / BuildKit caching this becomes a cache hit on most
# deploys.
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# ---- 2) Build the React Router server bundle ----
FROM deps AS builder
WORKDIR /app
COPY . .
RUN npm run build

# ---- 3) Production-only dependencies (no devDependencies) ----
# Independent stage so the runner can copy a slim node_modules. Cache key is
# also package*.json, so cache hits whenever lockfile is unchanged.
FROM node:20-alpine AS prod_deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- 4) Tiny runtime image ----
FROM node:20-alpine AS runner
WORKDIR /app

# Injected by CI (e.g. Kaniko `--build-arg`). Shown on Admin → Release notes.
ARG PRINTDOCK_BUILD_ID=
ARG PRINTDOCK_DEPLOYED_AT=
ARG PRINTDOCK_BACKEND_VERSION=
ENV PRINTDOCK_BUILD_ID=${PRINTDOCK_BUILD_ID}
ENV PRINTDOCK_DEPLOYED_AT=${PRINTDOCK_DEPLOYED_AT}
ENV PRINTDOCK_BACKEND_VERSION=${PRINTDOCK_BACKEND_VERSION}

# Copy only what the runtime needs.
COPY --from=builder /app/build ./build
COPY --from=builder /app/package.json ./
COPY --from=prod_deps /app/node_modules ./node_modules

# Cloud Run requires the app to listen on the port defined by the PORT env var.
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["npm", "start"]
