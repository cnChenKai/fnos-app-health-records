ARG NODE_IMAGE=node:22-bookworm-slim
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
ARG APP_VERSION
ARG GATEWAY_PREFIX=/
ENV APP_VERSION=${APP_VERSION} \
    GATEWAY_PREFIX=${GATEWAY_PREFIX}
RUN npm run build

FROM ${NODE_IMAGE} AS runtime

LABEL org.opencontainers.image.title="健康档案" \
      org.opencontainers.image.description="Family health report archive and AI-assisted record management" \
      org.opencontainers.image.source="https://github.com/timor-m/fnos-app-health-records" \
      org.opencontainers.image.licenses="MIT"

RUN apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 update \
    && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 install -y --no-install-recommends \
      ca-certificates curl python3 python3-venv tini \
      libxcb1 libglib2.0-0 libgl1 libsm6 libxext6 libxrender1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build --chown=node:node /app/.server-dist ./.server-dist
COPY --from=build --chown=node:node /app/scripts/start.mjs ./scripts/start.mjs
COPY --from=build --chown=node:node /app/scripts/reset-local-admin-password.mjs ./scripts/reset-local-admin-password.mjs
COPY --from=build --chown=node:node /app/packages/ocr-worker ./packages/ocr-worker
COPY --from=build --chown=node:node /app/template.config.json /app/package.json ./

RUN mkdir -p /data && chown -R node:node /data /app

ENV NODE_ENV=production \
    GATEWAY_PREFIX=/ \
    HOST=0.0.0.0 \
    PORT=3334 \
    STORAGE_DIR=/data \
    LOG_DIR=/data/logs \
    OCR_WORKER_SCRIPT=/app/packages/ocr-worker/worker.py \
    OCR_SETUP_SCRIPT=/app/packages/ocr-worker/setup-runtime.sh \
    OCR_PYTHON_BIN=/data/ocr-venv/bin/python

USER node
EXPOSE 3334
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3334/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "scripts/start.mjs"]
