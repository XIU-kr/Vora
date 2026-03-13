# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Vora is a web-based AI image editing engine. It has three layers:
1. **React/TypeScript frontend** (`web/`) — canvas editor using Konva
2. **Node.js/Express server** (`server/`) — orchestrates AI operations
3. **Python worker** (`server/python/lama_worker.py`) — runs Big-LaMa inpainting and SAM segmentation via stdin/stdout JSON protocol

## Commands

```bash
# Install root dependencies (concurrently)
npm install

# Run both server and web in dev mode
npm run dev
# Server runs on :18743, web on :5173 (Vite proxies /api → :18743)

# Build both for production
npm run build

# Server only
npm --prefix server run dev   # dev (tsx watch)
npm --prefix server run build # tsc compile → server/dist/

# Web only
npm --prefix web run dev      # Vite HMR
npm --prefix web run build    # → web/dist/

# Lint (frontend only, ESLint)
npm --prefix web run lint

# Health check (also triggers Python worker init)
curl http://localhost:18743/api/health

# Docker (production with GPU)
docker run --rm --gpus all -p 18743:18743 xiukr/vora:latest

# Docker (dev with live-reload volumes)
docker-compose -f docker-compose.dev.yml up
```

There are no automated tests in this codebase. CI (`.github/workflows/ci.yml`) runs `npm ci && npm run build` for both `web/` and `server/` on every push and PR.

## Architecture

### Frontend (`web/src/`)
- `App.tsx` — monolithic main component (~8500 lines). Contains all canvas state, tool logic, undo/history, layer management, and UI. Read this file carefully before modifying any editor behavior.
- `lib/api.ts` — HTTP client for `POST /api/inpaint` and `POST /api/segment-point`. Uses `AbortController` with 95s timeout.
- `lib/types.ts` — all shared TypeScript types: `Tool`, `MaskStroke`, `TextItem`, `LayerGroup`, `PageAsset`, `HistoryEntry`.
- `lib/importers.ts` — file import logic (images and PDF pages via `pdfjs-dist`).
- `lib/download.ts` — blob download helper.
- Notable client-side libraries: `konva`/`react-konva` (canvas), `jspdf` (PDF export), `pptxgenjs` (PPTX export), `tesseract.js` (OCR), `pdfjs-dist` (PDF import), `@fortawesome` (icons).

### Server (`server/src/index.ts`)
- `LamaWorkerClient` class spawns `lama_worker.py` as a subprocess and communicates via JSON lines over stdin/stdout.
- Python binary is auto-detected (checks venv, then `python3`, `python` — override with `VORA_PYTHON`).
- Express routes: `GET /api/health`, `POST /api/inpaint`, `POST /api/segment-point`, `POST /api/device`. The catch-all serves `web/dist` (SPA fallback).
- File uploads are handled by Multer (in-memory, no disk writes).

### Python Worker (`server/python/lama_worker.py`)
- Loads Big-LaMa (inpainting) and SAM (segmentation) at startup.
- SAM has two backends: `sam_vit` (Hugging Face transformers) or `sam2` (Meta SAM2). Selected based on `VORA_SAM_MODEL`.
- Communicates via JSON on stdin → stdout. Each request is a JSON line; each response is a JSON line.
- Images are passed as base64-encoded PNG strings.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 18743 | Server port |
| `VORA_DEVICE` | auto | `auto` / `cpu` / `cuda` |
| `VORA_SAM_MODEL` | vit_l | `vit_l`, `vit_b`, `vit_h`, or a SAM2 model ID |
| `VORA_LAMA_FP16` | 0 | Enable fp16 for Big-LaMa on CUDA (`1` = on) |
| `VORA_PYTHON` | (auto) | Path to Python executable |
| `VORA_WORKER_TIMEOUT_MS` | 120000 | Per-request timeout for worker |
| `VORA_BOOT_TIMEOUT_MS` | 600000 | Worker startup timeout |

## Key Patterns

- **Worker protocol**: Node sends `{"id": "...", "cmd": "inpaint"|"segment_point", ...}` as a JSON line; Python responds with `{"id": "...", "status": "ok", "image": "<base64>"}` or `{"id": "...", "status": "error", "error": "..."}`.
- **Device fallback**: CUDA errors in the Python worker trigger a fallback to CPU with a warning surfaced in `/api/health`.
- **SAM mask squeeze**: SAM/SAM2 output masks may have extra dimensions — the worker loops to squeeze until the mask is 2D before converting to PIL.
- **Docker multi-stage**: Stage 1 builds `web/dist`, Stage 2 builds `server/dist`, Stage 3 is CUDA 12.8.1 runtime that copies both. Registry-based layer caching is used (`docker-publish.yml`).
