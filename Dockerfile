FROM node:20-bookworm-slim AS web-build
WORKDIR /src/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:20-bookworm-slim AS server-build
WORKDIR /src/server
COPY server/package*.json ./
RUN npm ci
COPY server/ ./
RUN npm run build

FROM nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04 AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=18743
ENV LAMIVI_DEVICE=auto
ENV LAMIVI_PYTHON=/opt/venv-lama/bin/python
ENV LAMIVI_WORKER_TIMEOUT_MS=600000
ENV LAMIVI_BOOT_TIMEOUT_MS=120000
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Etc/UTC

RUN apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends \
    curl \
    python3 \
    python3-venv \
    libgl1 \
    libglib2.0-0 \
    libgomp1 \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
  && apt-get update \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

# LaMa runtime env (GPU-first with CPU fallback).
RUN python3 -m venv /opt/venv-lama \
  && /opt/venv-lama/bin/python -m pip install --no-cache-dir --upgrade "pip>=24.3.1" "setuptools>=78.1.1" "wheel>=0.46.3" \
  && /opt/venv-lama/bin/python -m pip install --no-cache-dir \
    --index-url https://download.pytorch.org/whl/cu128 \
    torch==2.9.1 torchvision==0.24.1 \
  && /opt/venv-lama/bin/python -m pip install --no-cache-dir \
    fire==0.5.0 "pillow>=11.0.0" "filelock>=3.20.3" numpy==1.26.4 opencv-python==4.10.0.84 \
  && /opt/venv-lama/bin/python -m pip install --no-cache-dir \
    --no-deps simple-lama-inpainting==0.1.2

COPY --from=server-build /src/server/package.json /app/server/package.json
COPY --from=server-build /src/server/node_modules /app/server/node_modules
COPY --from=server-build /src/server/dist /app/server/dist
COPY --from=server-build /src/server/python /app/server/python
COPY --from=web-build /src/web/dist /app/web/dist

EXPOSE 18743

CMD ["node", "server/dist/index.js"]
