# Vora AI

Web-based AI image editing engine built for smart visual editing.

- Repository: `https://github.com/XIU-kr/Vora`
- Repository name: `vora`
- Developer: `XIU-kr`
- Docker image: `docker.io/xiukr/vora:latest`

## Core features

- AI restore uses Big-LaMa (GPU-first with CPU fallback).
- AI select tool uses SAM2 point-based segmentation.
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
  -e LAMIVI_DEVICE=auto \
  -e LAMIVI_SAM_MODEL=facebook/sam2.1-hiera-large \
  -e LAMIVI_WORKER_TIMEOUT_MS=600000 \
  -e LAMIVI_BOOT_TIMEOUT_MS=120000 \
  xiukr/vora:latest
```

- `LAMIVI_DEVICE=auto|cpu|cuda`
- `LAMIVI_SAM_MODEL`: SAM2 model id (default: `facebook/sam2.1-hiera-large`)
- `LAMIVI_WORKER_TIMEOUT_MS`: worker request timeout
- `LAMIVI_BOOT_TIMEOUT_MS`: worker startup timeout

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

- Main automatic Docker publish target is `dev`.
- `latest` is intended for manual release publication.
- Docker Hub repository: `XIUkr/Vora`.
