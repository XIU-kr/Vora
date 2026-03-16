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

ENV NODE_ENV=production \
    PORT=18743 \
    VORA_DEVICE=auto \
    VORA_SAM_MODEL=vit_l \
    VORA_LAMA_FP16=0 \
    VORA_PYTHON=/opt/venv-lama/bin/python \
    VORA_WORKER_TIMEOUT_MS=600000 \
    VORA_BOOT_TIMEOUT_MS=600000 \
    DEBIAN_FRONTEND=noninteractive \
    TZ=Etc/UTC

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg \
    python3 python3-venv \
    libgl1 libglib2.0-0 libgomp1 \
  && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

# Install uv for fast Python package management
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Create venv and install heavy torch separately for caching
RUN uv venv /opt/venv-lama \
  && uv pip install --python /opt/venv-lama/bin/python --no-cache \
    --index-url https://download.pytorch.org/whl/cu128 \
    torch==2.9.1 torchvision==0.24.1

# Install lighter python deps
RUN uv pip install --python /opt/venv-lama/bin/python --no-cache \
    fire==0.5.0 "pillow>=11.0.0" "filelock>=3.20.3" numpy==1.26.4 opencv-python==4.10.0.84 "transformers>=4.45.0" \
  && uv pip install --python /opt/venv-lama/bin/python --no-cache --no-deps \
    simple-lama-inpainting==0.1.2 \
  && SAM2_BUILD_CUDA=0 uv pip install --python /opt/venv-lama/bin/python --no-cache \
    hydra-core==1.3.2 iopath==0.1.10 omegaconf==2.3.0 sam2

COPY --from=server-build /src/server/package.json /app/server/package.json
COPY --from=server-build /src/server/node_modules /app/server/node_modules
COPY --from=server-build /src/server/dist /app/server/dist
COPY --from=server-build /src/server/python /app/server/python
COPY --from=web-build /src/web/dist /app/web/dist

EXPOSE 18743
CMD ["node", "server/dist/index.js"]
