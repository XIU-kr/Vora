# Vora AI

Web-based AI image editing engine built for smart visual editing.

- Repository: `https://github.com/XIU-kr/Vora`
- Repository name: `vora`
- Developer: `XIU-kr`
- Docker image: `docker.io/xiukr/vora:latest`

## Core features

- AI restore uses Big-LaMa (GPU-first with CPU fallback).
- AI select tool uses SAM `vit_l` by default (point-based segmentation).
- After selecting a subject, right panel actions support:
  - delete selected area,
  - transparent background,
  - solid color background fill,
  - background image replacement,
  - AI restore on selected area.

## Docker quick start

Default app URL after start:

`http://localhost:18743`

### 1) Pull latest image

```bash
docker pull xiukr/vora:latest
```

### 2) Run with GPU (recommended)

```bash
docker run --rm --gpus all -p 18743:18743 xiukr/vora:latest
```

### 3) Run with CPU fallback

```bash
docker run --rm -p 18743:18743 xiukr/vora:latest
```

## Optional runtime environment variables

```bash
docker run --rm --gpus all -p 18743:18743 \
  -e VORA_DEVICE=auto \
  -e VORA_SAM_MODEL=vit_l \
  -e VORA_LAMA_FP16=1 \
  -e VORA_WORKER_TIMEOUT_MS=600000 \
  -e VORA_BOOT_TIMEOUT_MS=120000 \
  xiukr/vora:latest
```

- `VORA_DEVICE=auto|cpu|cuda`
- `VORA_SAM_MODEL`: `vit_l` (default), `vit_b`, `vit_h`, or SAM2 model id (example: `facebook/sam2.1-hiera-large`)
- `VORA_LAMA_FP16`: Big-LaMa fp16 mode on CUDA (`1` default, `0` to disable)
- `VORA_WORKER_TIMEOUT_MS`: worker request timeout
- `VORA_BOOT_TIMEOUT_MS`: worker startup timeout

## Health check

```bash
curl http://localhost:18743/api/health
```

## Update to newest image

```bash
docker pull xiukr/vora:latest
docker stop vora 2>/dev/null || true
docker rm vora 2>/dev/null || true
docker run -d --name vora --gpus all -p 18743:18743 xiukr/vora:latest
```

## Notes

- Docker publish workflow always pushes `xiukr/vora:latest`.
- Docker Hub image path used for pull/run/publish: `xiukr/vora` (Docker Hub UI may display `XIUkr/Vora`).
