from __future__ import annotations

import base64
import io
import json
import os
import sys
import traceback
from typing import Any

import numpy as np
from PIL import Image

try:
    import torch
except Exception:  # noqa: BLE001
    torch = None

from simple_lama_inpainting import SimpleLama

try:
    from sam2.sam2_image_predictor import SAM2ImagePredictor
except Exception:  # noqa: BLE001
    SAM2ImagePredictor = None


def _cuda_available() -> bool:
    return bool(torch is not None and hasattr(torch, "cuda") and torch.cuda.is_available())


def _pick_device() -> tuple[str, str, str | None]:
    requested = os.environ.get("VORA_DEVICE", "auto").strip().lower()
    requested = requested if requested in ("auto", "cpu", "cuda") else "auto"

    if requested == "cpu":
        return requested, "cpu", None

    if requested == "cuda":
        if _cuda_available():
            return requested, "cuda", None
        warning = "VORA_DEVICE=cuda requested, but torch.cuda.is_available() is False. Falling back to CPU."
        return requested, "cpu", warning

    if _cuda_available():
        return requested, "cuda", None
    return requested, "cpu", None


def _is_cuda_compat_error(err: Exception) -> bool:
    msg = str(err).lower()
    return (
        "no kernel image is available" in msg
        or "is not compatible with the current pytorch installation" in msg
        or ("cuda capability" in msg and "sm_" in msg)
    )


def _load_big_lama(device: str) -> tuple[Any, str | None]:
    warning: str | None = None
    try:
        # Explicit Big-LaMa request when wrapper supports it.
        return SimpleLama(model="big-lama", device=device), None
    except TypeError:
        pass
    except Exception as e:  # noqa: BLE001
        if device == "cuda" and _is_cuda_compat_error(e):
            warning = (
                "CUDA is available but this GPU/PyTorch combination is not supported by the current runtime. "
                "Big-LaMa fallback to CPU."
            )
            try:
                return SimpleLama(model="big-lama", device="cpu"), warning
            except TypeError:
                return SimpleLama(device="cpu"), warning
        raise

    # Wrapper fallback signatures.
    try:
        return SimpleLama(device=device), None
    except TypeError:
        return SimpleLama(), None


def _load_sam_predictor(device: str) -> tuple[Any, str, str | None]:
    model_name = os.environ.get("VORA_SAM_MODEL", "facebook/sam2.1-hiera-large").strip()
    if not model_name:
        model_name = "facebook/sam2.1-hiera-large"

    if SAM2ImagePredictor is None:
        raise RuntimeError("SAM2 is not installed. Install 'sam2' package.")

    warning: str | None = None
    try:
        predictor = SAM2ImagePredictor.from_pretrained(model_name, device=device)
        return predictor, model_name, warning
    except TypeError:
        predictor = SAM2ImagePredictor.from_pretrained(model_name)
        return predictor, model_name, warning
    except Exception as e:  # noqa: BLE001
        if device == "cuda" and _is_cuda_compat_error(e):
            warning = "SAM2 CUDA runtime failed. Falling back to CPU."
            try:
                predictor = SAM2ImagePredictor.from_pretrained(model_name, device="cpu")
                return predictor, model_name, warning
            except TypeError:
                predictor = SAM2ImagePredictor.from_pretrained(model_name)
                return predictor, model_name, warning
        raise


REQUESTED_DEVICE, DEVICE, DEVICE_WARNING = _pick_device()
LAMA_MODEL, LAMA_WARNING = _load_big_lama(DEVICE)
SAM_PREDICTOR, SAM_MODEL_NAME, SAM_WARNING = _load_sam_predictor(DEVICE)

ALL_WARNINGS = [w for w in [DEVICE_WARNING, LAMA_WARNING, SAM_WARNING] if w]


def _decode_image(b64: str, mode: str) -> Image.Image:
    raw = base64.b64decode(b64)
    return Image.open(io.BytesIO(raw)).convert(mode)


def _encode_png(img: Image.Image) -> str:
    out = io.BytesIO()
    img.save(out, format="PNG")
    return base64.b64encode(out.getvalue()).decode("ascii")


def _write(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def _run_inpaint(image_b64: str, mask_b64: str) -> Image.Image:
    image = _decode_image(image_b64, "RGB")
    mask = _decode_image(mask_b64, "L")
    return LAMA_MODEL(image, mask)


def _run_segment_point(image_b64: str, point_x: int, point_y: int) -> Image.Image:
    image = _decode_image(image_b64, "RGB")
    image_np = np.array(image)
    h, w = image_np.shape[:2]
    x = max(0, min(int(point_x), max(0, w - 1)))
    y = max(0, min(int(point_y), max(0, h - 1)))

    with torch.inference_mode() if torch is not None else _nullcontext():
        SAM_PREDICTOR.set_image(image_np)
        masks, scores, _ = SAM_PREDICTOR.predict(
            point_coords=np.array([[x, y]], dtype=np.float32),
            point_labels=np.array([1], dtype=np.int32),
            multimask_output=True,
        )

    if masks is None or len(masks) == 0:
        raise RuntimeError("SAM2 returned no masks")

    best_idx = int(np.argmax(scores)) if scores is not None and len(scores) > 0 else 0
    best_mask = masks[best_idx]
    mask_u8 = (best_mask.astype(np.uint8) * 255)
    return Image.fromarray(mask_u8, mode="L")


class _nullcontext:
    def __enter__(self) -> None:
        return None

    def __exit__(self, exc_type, exc, tb) -> None:  # type: ignore[no-untyped-def]
        return None


_write(
    {
        "type": "ready",
        "requested_device": REQUESTED_DEVICE,
        "device": DEVICE,
        "cuda_available": _cuda_available(),
        "model": "big-lama",
        "sam_model": SAM_MODEL_NAME,
        "warning": " | ".join(ALL_WARNINGS) if ALL_WARNINGS else None,
    }
)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
        req_id = req.get("id")
        op = req.get("op")
        image_b64 = req.get("image_b64")

        if not isinstance(req_id, str) or not isinstance(image_b64, str):
            _write({"id": req_id, "ok": False, "error": "Invalid request payload"})
            continue

        if op == "segment_point":
            point_x = req.get("point_x")
            point_y = req.get("point_y")
            if not isinstance(point_x, (int, float)) or not isinstance(point_y, (int, float)):
                _write({"id": req_id, "ok": False, "error": "Invalid segment point payload"})
                continue
            result = _run_segment_point(image_b64, int(round(point_x)), int(round(point_y)))
            out_b64 = _encode_png(result)
            _write({"id": req_id, "ok": True, "output_b64": out_b64})
            continue

        if op not in (None, "inpaint"):
            _write({"id": req_id, "ok": False, "error": f"Unsupported operation: {op}"})
            continue

        mask_b64 = req.get("mask_b64")
        if not isinstance(mask_b64, str):
            _write({"id": req_id, "ok": False, "error": "Invalid inpaint payload"})
            continue

        result = _run_inpaint(image_b64, mask_b64)
        out_b64 = _encode_png(result)
        _write({"id": req_id, "ok": True, "output_b64": out_b64})
    except Exception as e:  # noqa: BLE001
        _write(
            {
                "ok": False,
                "error": f"{type(e).__name__}: {e}",
                "trace": traceback.format_exc(limit=1),
            }
        )
