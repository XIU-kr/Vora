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
ENV VORA_DEVICE=auto
ENV VORA_SAM_MODEL=vit_l
ENV VORA_LAMA_FP16=1
ENV VORA_PYTHON=/opt/venv-lama/bin/python
ENV VORA_WORKER_TIMEOUT_MS=600000
ENV VORA_BOOT_TIMEOUT_MS=600000
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
    fire==0.5.0 "pillow>=11.0.0" "filelock>=3.20.3" numpy==1.26.4 opencv-python==4.10.0.84 "transformers>=4.45.0" \
  && /opt/venv-lama/bin/python -m pip install --no-cache-dir \
    --no-deps simple-lama-inpainting==0.1.2 \
  && SAM2_BUILD_CUDA=0 /opt/venv-lama/bin/python -m pip install --no-cache-dir \
    hydra-core==1.3.2 iopath==0.1.10 omegaconf==2.3.0 sam2

COPY --from=server-build /src/server/package.json /app/server/package.json
COPY --from=server-build /src/server/node_modules /app/server/node_modules
COPY --from=server-build /src/server/dist /app/server/dist
COPY --from=server-build /src/server/python /app/server/python
COPY --from=web-build /src/web/dist /app/web/dist

EXPOSE 18743

CMD ["node", "server/dist/index.js"]
