#!/usr/bin/env python3
"""Single-process health report OCR worker using NDJSON over stdin/stdout.

PDF rendering is intentionally kept in this worker so the Nitro process stays
free of native image/PDF dependencies.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import sys
import time
import traceback
import tempfile
from pathlib import Path
from typing import Any

ENGINE_NAME = "rapidocr"
MODEL_VERSION = "PP-OCRv4-mobile"
CURRENT_ENGINE_NAME = "rapidocr-uninitialized"
CURRENT_ENGINE_VERSION = "unknown"


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), flush=True)


def load_engine():
    requested = str(os.environ.get("OCR_BACKEND", "auto")).strip().lower()
    candidates = ["openvino", "onnxruntime"] if requested in {"", "auto"} else [requested]
    errors: list[str] = []

    for candidate in candidates:
        try:
            if candidate == "openvino":
                from rapidocr_openvino import RapidOCR
                import rapidocr_openvino

                return {
                    "name": "rapidocr-openvino",
                    "version": getattr(rapidocr_openvino, "__version__", "unknown"),
                    "engine": RapidOCR(),
                }
            if candidate in {"onnx", "onnxruntime"}:
                from rapidocr_onnxruntime import RapidOCR
                import rapidocr_onnxruntime

                return {
                    "name": "rapidocr-onnxruntime",
                    "version": getattr(rapidocr_onnxruntime, "__version__", "unknown"),
                    "engine": RapidOCR(),
                }
            errors.append(f"Unsupported OCR backend: {candidate}")
        except Exception as error:
            errors.append(f"{candidate}: {error}")

    raise RuntimeError("No OCR backend is available. " + " | ".join(errors))



def find_smoke_test_font() -> str | None:
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial.ttf",
    ]
    for candidate in candidates:
        if Path(candidate).is_file():
            return candidate
    return None


def create_smoke_test_image(path: Path) -> None:
    from PIL import Image, ImageDraw, ImageFont

    font_path = find_smoke_test_font()
    if font_path:
        image = Image.new("RGB", (960, 260), "white")
        draw = ImageDraw.Draw(image)
        font = ImageFont.truetype(font_path, 76)
        small_font = ImageFont.truetype(font_path, 30)
        draw.text((44, 56), "OCR TEST 2026", fill=(0, 0, 0), font=font)
        draw.text((48, 165), "health records smoke check", fill=(0, 0, 0), font=small_font)
    else:
        image = Image.new("RGB", (240, 80), "white")
        draw = ImageDraw.Draw(image)
        font = ImageFont.load_default()
        draw.text((8, 16), "OCR TEST 2026", fill=(0, 0, 0), font=font)
        draw.text((8, 42), "health records", fill=(0, 0, 0), font=font)
        image = image.resize((960, 320), Image.Resampling.NEAREST)
    image.save(path)


def run_smoke_test() -> dict[str, Any]:
    started = time.perf_counter()
    backend = load_engine()
    engine = backend["engine"]
    load_elapsed_ms = round((time.perf_counter() - started) * 1000)

    with tempfile.TemporaryDirectory(prefix="health-records-ocr-check-") as temp_name:
        image_path = Path(temp_name) / "ocr-smoke-test.png"
        create_smoke_test_image(image_path)
        recognize_started = time.perf_counter()
        lines, engine_elapsed = recognize_image(engine, image_path, None)
        recognize_elapsed_ms = round((time.perf_counter() - recognize_started) * 1000)

    texts = [str(line.get("text", "")) for line in lines]
    joined = " ".join(texts).upper()
    if "OCR" not in joined or "2026" not in joined:
        raise RuntimeError(f"OCR smoke test did not recognize expected text. recognized={texts[:8]}")

    return {
        "backend": backend["name"],
        "backendVersion": backend["version"],
        "engineLoadMs": load_elapsed_ms,
        "recognizeMs": recognize_elapsed_ms,
        "engineElapsed": engine_elapsed,
        "recognizedText": texts[:8],
    }


def runtime_check() -> int:
    try:
        import fitz
        import PIL
        import pillow_heif

        smoke = run_smoke_test()

        emit(
            {
                "ok": True,
                "engine": smoke["backend"],
                "modelVersion": MODEL_VERSION,
                "rapidocrVersion": smoke["backendVersion"],
                "pymupdfVersion": getattr(fitz, "version", ("unknown",))[0],
                "pillowVersion": getattr(PIL, "__version__", "unknown"),
                "pillowHeifVersion": getattr(pillow_heif, "__version__", "unknown"),
                "pythonVersion": sys.version.split()[0],
                "platform": platform.platform(),
                "machine": platform.machine(),
                "smokeTest": smoke,
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
                "platform": platform.platform(),
                "machine": platform.machine(),
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


def line_key(text: str) -> str:
    return "".join(character.lower() for character in text if character.isalnum())


def merge_pdf_text_and_ocr_lines(pdf_lines: list[dict[str, Any]], ocr_lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Prefer embedded PDF text, then add OCR-only content.

    Many hospital PDFs contain a partial text layer plus scanned/table images.
    Returning the text layer alone misses the image content; returning OCR alone
    may lose exact digital text. This merge keeps exact PDF text and adds OCR
    lines whose normalized text is not already present.
    """
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()

    for line in pdf_lines:
        text = str(line.get("text", "")).strip()
        key = line_key(text)
        if not key or key in seen:
            continue
        seen.add(key)
        merged.append({**line, "id": f"line_{len(merged) + 1}"})

    for line in ocr_lines:
        text = str(line.get("text", "")).strip()
        key = line_key(text)
        if not key or key in seen:
            continue
        # Skip very short OCR fragments when PDF text is already present; these
        # fragments are often punctuation/noise around table borders.
        if len(key) <= 1 and pdf_lines:
            continue
        seen.add(key)
        merged.append({**line, "id": f"line_{len(merged) + 1}"})

    return merged


def pdf_image_coverage(blocks: list[dict[str, Any]], page_area: float) -> float:
    if page_area <= 0:
        return 0
    image_area = 0.0
    for block in blocks:
        if block.get("type") != 1:
            continue
        bbox = block.get("bbox")
        if not isinstance(bbox, (list, tuple)) or len(bbox) < 4:
            continue
        try:
            width = max(0.0, float(bbox[2]) - float(bbox[0]))
            height = max(0.0, float(bbox[3]) - float(bbox[1]))
            image_area += width * height
        except Exception:
            continue
    return min(1.0, image_area / page_area)


def should_ocr_pdf_page(embedded_lines: list[dict[str, Any]], image_coverage: float) -> bool:
    text_length = sum(len(str(line.get("text", "")).strip()) for line in embedded_lines)
    if not embedded_lines:
        return True
    if len(embedded_lines) < 8:
        return True
    if text_length < 300:
        return True
    # A hospital PDF may contain a partial text layer plus a scanned table/image.
    # If the image area is meaningful, render the current page and merge OCR-only
    # content back into the embedded text layer. Tiny logos/seals usually stay
    # below this threshold and won't slow every digital PDF page down.
    if image_coverage >= 0.18:
        return True
    if image_coverage >= 0.06 and text_length < 1500:
        return True
    return False


def pdf_render_scale() -> float:
    try:
        requested = float(os.environ.get("OCR_PDF_RENDER_SCALE", "3") or 3)
    except Exception:
        requested = 3.0
    return max(2.0, min(4.0, requested))


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
    with tempfile.TemporaryDirectory(prefix="health-records-ocr-") as temp_name:
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
        blocks = embedded.get("blocks", [])
        image_coverage = pdf_image_coverage(blocks, float(page.rect.width * page.rect.height))
        has_image_blocks = image_coverage > 0
        embedded_lines: list[dict[str, Any]] = []
        for block in blocks:
            if block.get("type") != 0:
                continue
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
        if not should_ocr_pdf_page(embedded_lines, image_coverage):
            return embedded_lines, {
                "source": "pdf_text",
                "page": index + 1,
                "pdfTextLines": len(embedded_lines),
                "hasImageBlocks": has_image_blocks,
                "imageCoverage": round(image_coverage, 4),
            }

        with tempfile.TemporaryDirectory(prefix="health-record-pdf-") as temp_name:
            image_path = Path(temp_name) / f"page-{index + 1}.png"
            render_scale = pdf_render_scale()
            page.get_pixmap(matrix=fitz.Matrix(render_scale, render_scale), alpha=False).save(image_path)
            ocr_lines, elapsed = recognize_image(engine, image_path, image_role)
            if embedded_lines:
                lines = merge_pdf_text_and_ocr_lines(embedded_lines, ocr_lines)
                return lines, {
                    "source": "pdf_text_plus_render",
                    "page": index + 1,
                    "renderScale": render_scale,
                    "pdfTextLines": len(embedded_lines),
                    "ocrLines": len(ocr_lines),
                    "mergedLines": len(lines),
                    "hasImageBlocks": has_image_blocks,
                    "imageCoverage": round(image_coverage, 4),
                    "ocr": elapsed,
                }
            return ocr_lines, {
                "source": "pdf_render",
                "page": index + 1,
                "renderScale": render_scale,
                "ocrLines": len(ocr_lines),
                "hasImageBlocks": has_image_blocks,
                "imageCoverage": round(image_coverage, 4),
                "ocr": elapsed,
            }


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
    backend = None
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
                    backend = load_engine()
                    engine = backend["engine"]
                lines, engine_elapsed = recognize_input(
                    engine,
                    image_path,
                    str(request.get("imageRole") or ""),
                    int(page_number) if page_number is not None else None,
                )
                result = {
                    "engine": backend["name"] if backend else ENGINE_NAME,
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
