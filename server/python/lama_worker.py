from __future__ import annotations

import base64
import io
import json
import os
import sys
import traceback
from typing import Any

from PIL import Image

try:
    import torch
except Exception:  # noqa: BLE001
    torch = None

from simple_lama_inpainting import SimpleLama


def _cuda_available() -> bool:
    return bool(torch is not None and hasattr(torch, "cuda") and torch.cuda.is_available())


def _pick_device() -> tuple[str, str, str | None]:
    requested = os.environ.get("LAMIVI_DEVICE", "auto").strip().lower()
    requested = requested if requested in ("auto", "cpu", "cuda") else "auto"

    if requested == "cpu":
        return requested, "cpu", None

    if requested == "cuda":
        if _cuda_available():
            return requested, "cuda", None
        warning = "LAMIVI_DEVICE=cuda requested, but torch.cuda.is_available() is False. Falling back to CPU."
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


def _load_model() -> Any:
    requested, device, warning = _pick_device()
    device_arg: Any = device
    try:
        model = SimpleLama(device=device_arg)
    except TypeError:
        model = SimpleLama()
    except Exception as e:  # noqa: BLE001
        if device == "cuda" and _is_cuda_compat_error(e):
            cpu_device: Any = "cpu"
            model = SimpleLama(device=cpu_device)
            warning = (
                "CUDA is available but this GPU/PyTorch combination is not supported by the current runtime. "
                "Falling back to CPU."
            )
            return model, requested, "cpu", warning
        raise
    return model, requested, device, warning


MODEL, REQUESTED_DEVICE, DEVICE, DEVICE_WARNING = _load_model()


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


_write(
    {
        "type": "ready",
        "requested_device": REQUESTED_DEVICE,
        "device": DEVICE,
        "cuda_available": _cuda_available(),
        "warning": DEVICE_WARNING,
    }
)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
        req_id = req.get("id")
        image_b64 = req.get("image_b64")
        mask_b64 = req.get("mask_b64")

        if not isinstance(req_id, str) or not isinstance(image_b64, str) or not isinstance(mask_b64, str):
            _write({"id": req_id, "ok": False, "error": "Invalid request payload"})
            continue

        image = _decode_image(image_b64, "RGB")
        mask = _decode_image(mask_b64, "L")
        result = MODEL(image, mask)
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
