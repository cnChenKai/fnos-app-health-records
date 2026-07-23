#!/usr/bin/env python3
"""Single-process health report OCR worker using NDJSON over stdin/stdout.

PDF rendering is intentionally kept in this worker so the Nitro process stays
free of native image/PDF dependencies.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import traceback
import tempfile
from pathlib import Path
from typing import Any

ENGINE_NAME = "rapidocr-openvino"
MODEL_VERSION = "PP-OCRv4-mobile"


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), flush=True)


def load_engine():
    from rapidocr_openvino import RapidOCR

    return RapidOCR()


def runtime_check() -> int:
    try:
        import openvino
        import rapidocr_openvino
        import fitz
        import PIL
        import pillow_heif

        emit(
            {
                "ok": True,
                "engine": ENGINE_NAME,
                "modelVersion": MODEL_VERSION,
                "rapidocrVersion": getattr(rapidocr_openvino, "__version__", "unknown"),
                "openvinoVersion": getattr(openvino, "__version__", "unknown"),
                "pymupdfVersion": getattr(fitz, "version", ("unknown",))[0],
                "pillowVersion": getattr(PIL, "__version__", "unknown"),
                "pillowHeifVersion": getattr(pillow_heif, "__version__", "unknown"),
                "pythonVersion": sys.version.split()[0],
            }
        )
        return 0
    except Exception as error:  # Runtime diagnostics must remain available without dependencies.
        emit(
            {
                "ok": False,
                "errorCode": "OCR_RUNTIME_UNAVAILABLE",
                "errorMessage": str(error),
                "pythonVersion": sys.version.split()[0],
            }
        )
        return 2


def normalize_result(result: Any, start_index: int = 0, variant: str | None = None) -> list[dict[str, Any]]:
    lines: list[dict[str, Any]] = []
    if not result:
        return lines

    for index, item in enumerate(result):
        if not item or len(item) < 3:
            continue
        box, text, confidence = item[0], item[1], item[2]
        if hasattr(box, "tolist"):
            box = box.tolist()
        line = {
            "id": f"line_{start_index + index + 1}",
            "text": str(text),
            "confidence": float(confidence),
            "box": box,
        }
        if variant:
            line["variant"] = variant
        lines.append(line)
    return lines


def dedupe_lines(lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    best: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for line in lines:
        text = str(line.get("text", "")).strip()
        key = "".join(character.lower() for character in text if character.isalnum())
        if not key:
            continue
        previous = best.get(key)
        if previous is None:
            best[key] = line
            order.append(key)
        elif float(line.get("confidence", 0)) > float(previous.get("confidence", 0)):
            best[key] = line
    return [best[key] for key in order]


def date_image_variants(image_path: Path, temp_dir: Path) -> list[tuple[str, Path]]:
    """Create lightweight variants that help dot-matrix / low-contrast date codes.

    RapidOCR handles regular package text well. Production dates are often tiny,
    reflective, or printed as pale dot-matrix codes, so we add a few CPU-cheap
    enhanced copies only for the date image role.
    """
    variants: list[tuple[str, Path]] = [("original", image_path)]
    try:
        import cv2

        image = cv2.imread(str(image_path))
        if image is None:
            return variants

        height, width = image.shape[:2]
        scale = 3 if max(height, width) < 1400 else 2
        enlarged = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
        gray = cv2.cvtColor(enlarged, cv2.COLOR_BGR2GRAY)

        clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
        contrast = clahe.apply(gray)
        sharpened = cv2.addWeighted(contrast, 1.7, cv2.GaussianBlur(contrast, (0, 0), 1.2), -0.7, 0)
        _, otsu = cv2.threshold(sharpened, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        adaptive = cv2.adaptiveThreshold(
            sharpened,
            255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY,
            31,
            7,
        )
        inverted = cv2.bitwise_not(adaptive)

        generated = [
            ("date_contrast", contrast),
            ("date_sharpen", sharpened),
            ("date_binary", otsu),
            ("date_adaptive_invert", inverted),
        ]
        for label, data in generated:
            path = temp_dir / f"{label}.png"
            if cv2.imwrite(str(path), data):
                variants.append((label, path))
    except Exception as error:
        print(f"OCR date preprocessing skipped: {error}", file=sys.stderr, flush=True)
    return variants


def recognize_image(engine: Any, image_path: Path, image_role: str | None) -> tuple[list[dict[str, Any]], Any]:
    if image_role != "date":
        result, engine_elapsed = engine(str(image_path))
        return normalize_result(result), engine_elapsed

    all_lines: list[dict[str, Any]] = []
    elapsed_parts: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="family-stock-ocr-") as temp_name:
        variants = date_image_variants(image_path, Path(temp_name))
        for label, variant_path in variants:
            started = time.perf_counter()
            result, engine_elapsed = engine(str(variant_path))
            elapsed_parts.append(
                {
                    "variant": label,
                    "engineElapsed": engine_elapsed,
                    "elapsedMs": round((time.perf_counter() - started) * 1000),
                }
            )
            all_lines.extend(normalize_result(result, len(all_lines), label))

    return dedupe_lines(all_lines), {"variants": elapsed_parts}


def recognize_input(
    engine: Any,
    input_path: Path,
    image_role: str | None,
    page_number: int | None,
) -> tuple[list[dict[str, Any]], Any]:
    if input_path.suffix.lower() != ".pdf":
        return recognize_image(engine, input_path, image_role)

    import fitz

    with fitz.open(input_path) as document:
        index = max(0, (page_number or 1) - 1)
        if index >= document.page_count:
            raise IndexError(f"PDF page does not exist: {page_number}")
        page = document.load_page(index)
        embedded = page.get_text("dict")
        embedded_lines: list[dict[str, Any]] = []
        for block in embedded.get("blocks", []):
            for line in block.get("lines", []):
                text = "".join(span.get("text", "") for span in line.get("spans", [])).strip()
                if text:
                    embedded_lines.append(
                        {
                            "id": f"line_{len(embedded_lines) + 1}",
                            "text": text,
                            "confidence": 1.0,
                            "box": line.get("bbox", []),
                            "variant": "pdf_text",
                        }
                    )
        if embedded_lines:
            return embedded_lines, {"source": "pdf_text", "page": index + 1}

        with tempfile.TemporaryDirectory(prefix="health-record-pdf-") as temp_name:
            image_path = Path(temp_name) / f"page-{index + 1}.png"
            page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False).save(image_path)
            lines, elapsed = recognize_image(engine, image_path, image_role)
            return lines, {"source": "pdf_render", "page": index + 1, "ocr": elapsed}


def inspect_pdf(input_path: Path) -> dict[str, Any]:
    import fitz

    with fitz.open(input_path) as document:
        return {
            "pageCount": document.page_count,
            "pages": [
                {
                    "pageNumber": index + 1,
                    "width": round(document.load_page(index).rect.width),
                    "height": round(document.load_page(index).rect.height),
                }
                for index in range(document.page_count)
            ],
        }


def create_thumbnail(
    input_path: Path,
    output_path: Path,
    page_number: int | None,
    rotation: int,
    max_size: int = 480,
    quality: int = 82,
    render_scale: float | None = None,
) -> dict[str, Any]:
    from PIL import Image, ImageOps

    if input_path.suffix.lower() == ".pdf":
        import fitz

        with fitz.open(input_path) as document:
            index = max(0, (page_number or 1) - 1)
            if index >= document.page_count:
                raise IndexError(f"PDF page does not exist: {page_number}")
            safe_render_scale = max(1.0, min(4.0, float(render_scale or 1.2)))
            pixmap = document.load_page(index).get_pixmap(matrix=fitz.Matrix(safe_render_scale, safe_render_scale), alpha=False)
            image = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)
    else:
        if input_path.suffix.lower() in {".heic", ".heif"}:
            from pillow_heif import register_heif_opener

            register_heif_opener()
        with Image.open(input_path) as source:
            image = ImageOps.exif_transpose(source).convert("RGB")

    if rotation:
        image = image.rotate(-rotation, expand=True)
    safe_max_size = max(240, min(2400, int(max_size or 480)))
    safe_quality = max(60, min(95, int(quality or 82)))
    image.thumbnail((safe_max_size, safe_max_size), Image.Resampling.LANCZOS)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(output_path, format="JPEG", quality=safe_quality, optimize=True)
    return {"width": image.width, "height": image.height, "outputPath": str(output_path)}


def run_daemon() -> int:
    emit(
        {
            "type": "ready",
            "ok": True,
            "engine": ENGINE_NAME,
            "modelVersion": MODEL_VERSION,
            "capabilities": ["inspect_pdf", "thumbnail", "ocr"],
        }
    )
    engine = None

    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue

        request_id = None
        try:
            request = json.loads(raw_line)
            request_id = request.get("id")
            image_path = Path(request["imagePath"])
            action = str(request.get("action") or "ocr")
            page_number = request.get("pageNumber")
            if not image_path.is_file():
                raise FileNotFoundError(f"Image does not exist: {image_path}")

            started = time.perf_counter()
            if action == "inspect_pdf":
                result = inspect_pdf(image_path)
            elif action == "thumbnail":
                result = create_thumbnail(
                    image_path,
                    Path(request["outputPath"]),
                    int(page_number) if page_number is not None else None,
                    int(request.get("rotation") or 0),
                    int(request.get("maxSize") or 480),
                    int(request.get("quality") or 82),
                    float(request.get("renderScale") or 0) or None,
                )
            elif action == "ocr":
                if engine is None:
                    engine = load_engine()
                lines, engine_elapsed = recognize_input(
                    engine,
                    image_path,
                    str(request.get("imageRole") or ""),
                    int(page_number) if page_number is not None else None,
                )
                result = {
                    "engine": ENGINE_NAME,
                    "modelVersion": MODEL_VERSION,
                    "lines": lines,
                    "engineElapsed": engine_elapsed,
                }
            else:
                raise ValueError(f"Unsupported worker action: {action}")
            elapsed_ms = round((time.perf_counter() - started) * 1000)
            emit(
                {
                    "id": request_id,
                    "ok": True,
                    "elapsedMs": elapsed_ms,
                    **result,
                }
            )
        except Exception as error:
            print(traceback.format_exc(), file=sys.stderr, flush=True)
            emit(
                {
                    "id": request_id,
                    "ok": False,
                    "errorCode": "WORKER_TASK_FAILED",
                    "errorMessage": str(error),
                }
            )

    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    return runtime_check() if args.check else run_daemon()


if __name__ == "__main__":
    raise SystemExit(main())
