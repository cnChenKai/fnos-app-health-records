#!/usr/bin/env python3
"""Single-process health report OCR worker using NDJSON over stdin/stdout.

PDF rendering is intentionally kept in this worker so the Nitro process stays
free of native image/PDF dependencies.
"""

from __future__ import annotations

import argparse
import gc
import json
import math
import os
import platform
import sys
import time
import traceback
import tempfile
import threading
from contextlib import suppress
from pathlib import Path
from typing import Any

ENGINE_NAME = "rapidocr"
MODEL_VERSION = "PP-OCRv4-mobile"
CURRENT_ENGINE_NAME = "rapidocr-uninitialized"
CURRENT_ENGINE_VERSION = "unknown"
_EMIT_LOCK = threading.Lock()

def emit(payload: dict[str, Any]) -> None:
    # Heartbeats are emitted from a helper thread while the main thread is inside
    # native OCR/PDF work. Serialize writes so every NDJSON envelope stays atomic.
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    with _EMIT_LOCK:
        print(encoded, flush=True)


class WorkerInputError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class ResourceBoundaryError(WorkerInputError):
    pass


class InputDecodeError(WorkerInputError):
    pass


SUPPORTED_MIME_TYPES = {
    "application/pdf": "pdf",
    "image/jpeg": "jpeg",
    "image/png": "png",
    "image/webp": "webp",
    "image/heic": "heic",
    "image/heif": "heic",
}


def detect_input_format(input_path: Path) -> str | None:
    try:
        with input_path.open("rb") as source:
            header = source.read(32)
    except Exception as error:
        raise ResourceBoundaryError("INPUT_FILE_INVALID", "Input file cannot be read") from error
    if header.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if len(header) >= 12 and header[:4] == b"RIFF" and header[8:12] == b"WEBP":
        return "webp"
    if header.startswith(b"%PDF-"):
        return "pdf"
    if len(header) >= 12 and header[4:8] == b"ftyp" and header[8:12] in {
        b"heic", b"heix", b"hevc", b"hevx", b"mif1", b"msf1"
    }:
        return "heic"
    return None


def expected_format_for_path(input_path: Path) -> str | None:
    return {
        ".pdf": "pdf",
        ".jpg": "jpeg",
        ".jpeg": "jpeg",
        ".png": "png",
        ".webp": "webp",
        ".heic": "heic",
        ".heif": "heic",
    }.get(input_path.suffix.lower())


def validate_input_format(
    input_path: Path,
    action: str,
    expected_mime_type: str | None = None,
) -> str:
    detected = detect_input_format(input_path)
    expected = SUPPORTED_MIME_TYPES.get(str(expected_mime_type or "").lower())
    path_expected = expected_format_for_path(input_path)
    if action == "inspect_pdf":
        expected = "pdf"
    if detected is None or (expected and detected != expected) or (path_expected and detected != path_expected):
        raise InputDecodeError("INPUT_FORMAT_MISMATCH", "Input file format does not match its declared type")
    return detected


def open_pdf_document(input_path: Path) -> Any:
    import fitz

    try:
        return fitz.open(input_path)
    except Exception as error:
        raise InputDecodeError("PDF_DECODE_FAILED", "PDF file cannot be decoded") from error


def open_image_source(input_path: Path) -> Any:
    try:
        if input_path.suffix.lower() in {".heic", ".heif"}:
            from pillow_heif import register_heif_opener

            register_heif_opener()
        from PIL import Image

        Image.MAX_IMAGE_PIXELS = max_image_pixels()
        return Image.open(input_path)
    except ResourceBoundaryError:
        raise
    except Exception as error:
        raise InputDecodeError("IMAGE_DECODE_FAILED", "Image file cannot be decoded") from error


def pdf_operation(operation: Any, message: str = "PDF content cannot be decoded") -> Any:
    try:
        return operation()
    except ResourceBoundaryError:
        raise
    except InputDecodeError:
        raise
    except Exception as error:
        raise InputDecodeError("PDF_DECODE_FAILED", message) from error


def cleanup_partial_output(output_path: Path | None) -> None:
    if output_path is None:
        return
    with suppress(Exception):
        if output_path.is_file():
            output_path.unlink()


def bounded_resource_limit(name: str, fallback: int, minimum: int, maximum: int) -> int:
    try:
        value = int(float(os.environ.get(name, str(fallback)) or fallback))
    except Exception:
        value = fallback
    return max(minimum, min(maximum, value))


def max_input_file_bytes() -> int:
    return bounded_resource_limit(
        "OCR_WORKER_MAX_INPUT_FILE_BYTES", 40 * 1024 * 1024, 1, 1024 * 1024 * 1024
    )


def max_pdf_pages() -> int:
    return bounded_resource_limit("OCR_WORKER_MAX_PDF_PAGES", 500, 1, 10000)


def max_image_pixels() -> int:
    return bounded_resource_limit(
        "OCR_WORKER_MAX_IMAGE_PIXELS", 40000000, 1000000, 500000000
    )


# OpenCV reads this boundary when the module is imported. Keep it aligned with
# the explicit application-level dimension check below, and normalize invalid
# environment values before native code sees them.
os.environ["OPENCV_IO_MAX_IMAGE_PIXELS"] = str(max_image_pixels())


def max_pdf_page_render_pixels() -> int:
    return bounded_resource_limit(
        "OCR_WORKER_MAX_PDF_PAGE_RENDER_PIXELS", 80000000, 1000000, 500000000
    )


def max_worker_rss_bytes() -> int:
    return bounded_resource_limit(
        "OCR_WORKER_MAX_RSS_BYTES",
        1536 * 1024 * 1024,
        1,
        16 * 1024 * 1024 * 1024,
    )


def max_ocr_requests_per_process() -> int:
    return bounded_resource_limit(
        "OCR_WORKER_MAX_OCR_REQUESTS_PER_PROCESS", 32, 1, 10000
    )


def worker_heartbeat_interval_seconds() -> float:
    milliseconds = bounded_resource_limit(
        "OCR_WORKER_HEARTBEAT_INTERVAL_MS", 15000, 100, 60000
    )
    return milliseconds / 1000


class RequestHeartbeat:
    def __init__(self, request_id: Any, action: str, started: float):
        self.request_id = request_id
        self.action = action
        self.started = started
        self.stopped = threading.Event()
        self.thread = threading.Thread(
            target=self._run,
            name="ocr-worker-heartbeat",
            daemon=True,
        )

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.stopped.set()
        self.thread.join(timeout=1.0)

    def _run(self) -> None:
        interval = worker_heartbeat_interval_seconds()
        while not self.stopped.wait(interval):
            emit(
                {
                    "type": "heartbeat",
                    "id": self.request_id,
                    "action": self.action,
                    "elapsedMs": round((time.perf_counter() - self.started) * 1000),
                }
            )


def process_rss_bytes() -> int:
    """Return current RSS where available, otherwise the process peak RSS."""
    try:
        statm = Path("/proc/self/statm").read_text(encoding="ascii").split()
        if len(statm) >= 2:
            return max(0, int(statm[1]) * int(os.sysconf("SC_PAGE_SIZE")))
    except Exception:
        pass
    return process_peak_rss_bytes()


def process_peak_rss_bytes() -> int:
    try:
        import resource

        maximum_rss = int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
        # macOS reports bytes; Linux and the common NAS Python runtimes report KiB.
        return max(0, maximum_rss if sys.platform == "darwin" else maximum_rss * 1024)
    except Exception:
        return 0


def release_request_resources() -> None:
    # Pillow, PyMuPDF, OpenCV and OCR backends may leave Python-side reference
    # cycles around native buffers. Collection here releases everything that is
    # no longer needed before deciding whether the process crossed its high-water
    # mark. Native allocator arenas are reclaimed by the planned process recycle.
    with suppress(Exception):
        gc.collect()


def worker_recycle_reason(
    action: str,
    recycle_after_response: bool,
    ocr_request_count: int,
    rss_bytes: int,
) -> str | None:
    if recycle_after_response and action == "ocr":
        return "report_boundary"
    if rss_bytes >= max_worker_rss_bytes():
        return "memory_high_water"
    if action == "ocr" and ocr_request_count >= max_ocr_requests_per_process():
        return "request_limit"
    return None


def validate_input_file(input_path: Path) -> None:
    try:
        size = input_path.stat().st_size
    except Exception as error:
        raise ResourceBoundaryError("INPUT_FILE_INVALID", f"Input file cannot be read: {input_path}") from error
    if not input_path.is_file():
        raise ResourceBoundaryError("INPUT_FILE_INVALID", f"Input path is not a regular file: {input_path}")
    if size < 1:
        raise ResourceBoundaryError("INPUT_FILE_EMPTY", f"Input file is empty: {input_path}")
    if size > max_input_file_bytes():
        raise ResourceBoundaryError("INPUT_FILE_TOO_LARGE", "Input file exceeds the worker safety limit")


def validate_image_dimensions(input_path: Path) -> tuple[int, int]:
    try:
        with open_image_source(input_path) as source:
            width, height = source.size
            if width < 1 or height < 1 or width * height > max_image_pixels():
                raise ResourceBoundaryError(
                    "IMAGE_DIMENSIONS_EXCEEDED",
                    f"Image dimensions exceed the worker safety limit: {width}x{height}",
                )
            # Pillow is lazy. Force the pixel stream to be decoded before the OCR
            # engine is loaded so truncated/corrupt images fail deterministically.
            source.load()
    except ResourceBoundaryError:
        raise
    except InputDecodeError:
        raise
    except Exception as error:
        raise InputDecodeError("IMAGE_DECODE_FAILED", "Image file cannot be decoded") from error
    return int(width), int(height)


def validate_pdf_document(document: Any) -> int:
    page_count = int(document.page_count)
    if page_count < 1:
        raise ResourceBoundaryError("PDF_PAGE_COUNT_INVALID", "PDF does not contain any pages")
    if page_count > max_pdf_pages():
        raise ResourceBoundaryError(
            "PDF_PAGE_COUNT_EXCEEDED",
            f"PDF page count exceeds the worker safety limit: {page_count}",
        )
    return page_count


def validate_pdf_page(page: Any, render_scale: float) -> tuple[float, float]:
    width = float(page.rect.width)
    height = float(page.rect.height)
    if not math.isfinite(width) or not math.isfinite(height) or width <= 0 or height <= 0:
        raise ResourceBoundaryError("PDF_PAGE_DIMENSIONS_INVALID", "PDF page dimensions are invalid")
    projected_width = math.ceil(width * render_scale)
    projected_height = math.ceil(height * render_scale)
    if projected_width * projected_height > max_pdf_page_render_pixels():
        raise ResourceBoundaryError(
            "PDF_PAGE_DIMENSIONS_EXCEEDED",
            f"PDF rendered page dimensions exceed the worker safety limit: {projected_width}x{projected_height}",
        )
    return width, height


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


def rotated_dimensions(width: float, height: float, rotation: int) -> tuple[float, float]:
    return (height, width) if rotation % 180 else (width, height)


def rotate_point_box(box: Any, rotation: int, width: float, height: float) -> list[float] | None:
    """Rotate a flat [x1, y1, x2, y2] box to match Image.rotate(-rotation, expand=True).

    The thumbnail/preview pipeline rotates pages with PIL; embedded PDF text boxes
    are reported in the unrotated page space, so they need the same transform to
    stay aligned with what the user sees.
    """
    if not isinstance(box, (list, tuple)) or len(box) < 4:
        return None
    try:
        x1, y1, x2, y2 = (float(value) for value in box[:4])
    except Exception:
        return None
    r = rotation % 360
    if not r:
        return [x1, y1, x2, y2]
    corners = [(x1, y1), (x2, y1), (x2, y2), (x1, y2)]
    if r == 90:
        points = [(height - y, x) for x, y in corners]
    elif r == 180:
        points = [(width - x, height - y) for x, y in corners]
    elif r == 270:
        points = [(y, width - x) for x, y in corners]
    else:
        return [x1, y1, x2, y2]
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    return [min(xs), min(ys), max(xs), max(ys)]


def scale_line_boxes(lines: list[dict[str, Any]], factor: float) -> list[dict[str, Any]]:
    """Divide every box coordinate by factor (rendered pixels -> page points).

    OCR runs on a rendered bitmap while embedded PDF text uses page points. The
    stored coordinate space must be uniform per page or overlays and spatial
    label/value pairing silently mix two spaces.
    """
    if factor == 1:
        return lines
    scaled: list[dict[str, Any]] = []
    for line in lines:
        box = line.get("box")
        new_box = box
        try:
            if isinstance(box, (list, tuple)) and box:
                if isinstance(box[0], (list, tuple)):
                    new_box = [
                        [round(float(point[0]) / factor, 2), round(float(point[1]) / factor, 2)]
                        for point in box
                        if isinstance(point, (list, tuple)) and len(point) >= 2
                    ]
                elif len(box) >= 4:
                    new_box = [round(float(value) / factor, 2) for value in box[:4]]
        except Exception:
            new_box = box
        scaled.append({**line, "box": new_box})
    return scaled


def prepare_ocr_image(
    input_path: Path,
    rotation: int,
    temp_dir: Path,
) -> tuple[Path, int | None, int | None]:
    """Return the image to OCR plus its coordinate-space dimensions.

    Previews are EXIF-transposed and rotated; OCR must see the same orientation
    or line boxes land in a different space than the image the user looks at.
    Returns the original path when no correction is needed, and degrades to the
    original path without dimensions when the imaging library is unavailable.
    """
    try:
        with open_image_source(input_path) as source:
            try:
                orientation = int(source.getexif().get(0x0112, 1) or 1)
            except Exception:
                orientation = 1
            if orientation in (0, 1) and not rotation % 360:
                return input_path, int(source.size[0]), int(source.size[1])
            from PIL import ImageOps

            image = ImageOps.exif_transpose(source).convert("RGB")
            image.load()
        if rotation % 360:
            rotated = image.rotate(-rotation, expand=True)
            image.close()
            image = rotated
        prepared_path = temp_dir / "ocr-input.png"
        try:
            image.save(prepared_path, format="PNG")
            return prepared_path, int(image.width), int(image.height)
        finally:
            image.close()
    except Exception as error:
        # 方向校正失败不应阻断 OCR：退回原图并保持历史行为（无坐标系尺寸）。
        print(f"OCR image orientation normalization skipped: {error}", file=sys.stderr, flush=True)
        return input_path, None, None


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
    rotation: int = 0,
) -> tuple[list[dict[str, Any]], Any, dict[str, float] | None]:
    if input_path.suffix.lower() != ".pdf":
        validate_image_dimensions(input_path)
        with tempfile.TemporaryDirectory(prefix="health-records-ocr-img-") as temp_name:
            ocr_path, coord_width, coord_height = prepare_ocr_image(
                input_path, rotation, Path(temp_name)
            )
            lines, engine_elapsed = recognize_image(engine, ocr_path, image_role)
        coord = None
        if coord_width and coord_height:
            coord = {
                "coordWidth": float(coord_width),
                "coordHeight": float(coord_height),
            }
        return lines, engine_elapsed, coord

    import fitz

    with open_pdf_document(input_path) as document:
        page_count = validate_pdf_document(document)
        index = max(0, (page_number or 1) - 1)
        if index >= page_count:
            raise IndexError(f"PDF page does not exist: {page_number}")
        page = pdf_operation(lambda: document.load_page(index))
        validate_pdf_page(page, pdf_render_scale())
        base_width = float(page.rect.width)
        base_height = float(page.rect.height)
        coord_width, coord_height = rotated_dimensions(base_width, base_height, rotation)
        coord = {"coordWidth": float(coord_width), "coordHeight": float(coord_height)}
        embedded = pdf_operation(lambda: page.get_text("dict"))
        blocks = embedded.get("blocks", [])
        image_coverage = pdf_image_coverage(blocks, base_width * base_height)
        has_image_blocks = image_coverage > 0
        embedded_lines: list[dict[str, Any]] = []
        for block in blocks:
            if block.get("type") != 0:
                continue
            for line in block.get("lines", []):
                text = "".join(span.get("text", "") for span in line.get("spans", [])).strip()
                if text:
                    box = line.get("bbox", [])
                    if rotation % 360:
                        box = rotate_point_box(box, rotation, base_width, base_height) or []
                    embedded_lines.append(
                        {
                            "id": f"line_{len(embedded_lines) + 1}",
                            "text": text,
                            "confidence": 1.0,
                            "box": box,
                            "variant": "pdf_text",
                        }
                    )
        del embedded, blocks
        if not should_ocr_pdf_page(embedded_lines, image_coverage):
            return embedded_lines, {
                "source": "pdf_text",
                "page": index + 1,
                "pdfTextLines": len(embedded_lines),
                "hasImageBlocks": has_image_blocks,
                "imageCoverage": round(image_coverage, 4),
            }, coord

        with tempfile.TemporaryDirectory(prefix="health-record-pdf-") as temp_name:
            image_path = Path(temp_name) / f"page-{index + 1}.png"
            render_scale = pdf_render_scale()
            pixmap = pdf_operation(
                lambda: page.get_pixmap(matrix=fitz.Matrix(render_scale, render_scale), alpha=False)
            )
            if rotation % 360:
                from PIL import Image

                rendered = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)
                del pixmap
                rotated = rendered.rotate(-rotation, expand=True)
                rendered.close()
                try:
                    rotated.save(image_path, format="PNG")
                finally:
                    rotated.close()
            else:
                pdf_operation(lambda: pixmap.save(image_path), "PDF page render cannot be decoded")
                del pixmap
            ocr_lines, elapsed = recognize_image(engine, image_path, image_role)
            ocr_lines = scale_line_boxes(ocr_lines, render_scale)
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
                }, coord
            return ocr_lines, {
                "source": "pdf_render",
                "page": index + 1,
                "renderScale": render_scale,
                "ocrLines": len(ocr_lines),
                "hasImageBlocks": has_image_blocks,
                "imageCoverage": round(image_coverage, 4),
                "ocr": elapsed,
            }, coord


def inspect_pdf(input_path: Path) -> dict[str, Any]:
    import fitz

    with open_pdf_document(input_path) as document:
        page_count = validate_pdf_document(document)
        pages = []
        render_scale = pdf_render_scale()
        for index in range(page_count):
            page = pdf_operation(lambda: document.load_page(index))
            width, height = validate_pdf_page(page, render_scale)
            pages.append(
                {
                    "pageNumber": index + 1,
                    "width": round(width),
                    "height": round(height),
                }
            )
            del page
        return {"pageCount": page_count, "pages": pages}


def create_thumbnail(
    input_path: Path,
    output_path: Path,
    page_number: int | None,
    rotation: int,
    max_size: int = 480,
    quality: int = 82,
    render_scale: float | None = None,
) -> dict[str, Any]:
    from PIL import Image

    if input_path.suffix.lower() == ".pdf":
        import fitz

        with open_pdf_document(input_path) as document:
            page_count = validate_pdf_document(document)
            index = max(0, (page_number or 1) - 1)
            if index >= page_count:
                raise IndexError(f"PDF page does not exist: {page_number}")
            safe_render_scale = max(1.0, min(4.0, float(render_scale or 1.2)))
            page = pdf_operation(lambda: document.load_page(index))
            validate_pdf_page(page, safe_render_scale)
            pixmap = pdf_operation(
                lambda: page.get_pixmap(matrix=fitz.Matrix(safe_render_scale, safe_render_scale), alpha=False)
            )
            image = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)
            del pixmap
    else:
        from PIL import ImageOps

        validate_image_dimensions(input_path)
        try:
            with open_image_source(input_path) as source:
                image = ImageOps.exif_transpose(source).convert("RGB")
                image.load()
        except ResourceBoundaryError:
            raise
        except InputDecodeError:
            raise
        except Exception as error:
            raise InputDecodeError("IMAGE_DECODE_FAILED", "Image file cannot be decoded") from error

    try:
        if rotation:
            rotated = image.rotate(-rotation, expand=True)
            with suppress(Exception):
                image.close()
            image = rotated
        safe_max_size = max(240, min(2400, int(max_size or 480)))
        safe_quality = max(60, min(95, int(quality or 82)))
        image.thumbnail((safe_max_size, safe_max_size), Image.Resampling.LANCZOS)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        image.save(output_path, format="JPEG", quality=safe_quality, optimize=True)
        return {"width": image.width, "height": image.height, "outputPath": str(output_path)}
    finally:
        with suppress(Exception):
            image.close()


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
    request_count = 0
    ocr_request_count = 0

    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue

        request_id = None
        action = None
        request = None
        recycle_after_response = False
        heartbeat = None
        try:
            request = json.loads(raw_line)
            request_id = request.get("id")
            image_path = Path(request["imagePath"])
            action = str(request.get("action") or "ocr")
            recycle_after_response = bool(request.get("recycleAfterResponse"))
            page_number = request.get("pageNumber")
            request_count += 1
            if action == "ocr":
                ocr_request_count += 1
            validate_input_file(image_path)
            validate_input_format(image_path, action, request.get("mimeType"))

            started = time.perf_counter()
            heartbeat = RequestHeartbeat(request_id, action, started)
            heartbeat.start()
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
                if image_path.suffix.lower() == ".pdf":
                    import fitz

                    with open_pdf_document(image_path) as document:
                        page_count = validate_pdf_document(document)
                        index = max(0, (int(page_number) if page_number is not None else 1) - 1)
                        if index >= page_count:
                            raise IndexError(f"PDF page does not exist: {page_number}")
                        page = pdf_operation(lambda: document.load_page(index))
                        validate_pdf_page(page, pdf_render_scale())
                else:
                    validate_image_dimensions(image_path)
                if engine is None:
                    backend = load_engine()
                    engine = backend["engine"]
                lines, engine_elapsed, coord = recognize_input(
                    engine,
                    image_path,
                    str(request.get("imageRole") or ""),
                    int(page_number) if page_number is not None else None,
                    int(request.get("rotation") or 0),
                )
                result = {
                    "engine": backend["name"] if backend else ENGINE_NAME,
                    "modelVersion": MODEL_VERSION,
                    "lines": lines,
                    "engineElapsed": engine_elapsed,
                }
                if coord:
                    result.update(coord)
            else:
                raise ValueError(f"Unsupported worker action: {action}")
            elapsed_ms = round((time.perf_counter() - started) * 1000)
            heartbeat.stop()
            heartbeat = None
            release_request_resources()
            rss_bytes = process_rss_bytes()
            peak_rss_bytes = process_peak_rss_bytes()
            recycle_reason = worker_recycle_reason(
                action,
                recycle_after_response,
                ocr_request_count,
                rss_bytes,
            )
            emit(
                {
                    "id": request_id,
                    "ok": True,
                    "elapsedMs": elapsed_ms,
                    "workerRssBytes": rss_bytes,
                    "workerPeakRssBytes": peak_rss_bytes,
                    "workerRequestCount": request_count,
                    "workerOcrRequestCount": ocr_request_count,
                    "recycleRecommended": recycle_reason is not None,
                    "recycleReason": recycle_reason,
                    **result,
                }
            )
        except Exception as error:
            if heartbeat is not None:
                heartbeat.stop()
                heartbeat = None
            if action == "thumbnail":
                raw_output_path = request.get("outputPath") if isinstance(request, dict) else None
                cleanup_partial_output(Path(raw_output_path) if raw_output_path else None)
            if isinstance(error, WorkerInputError):
                print(f"{error.code}: {error}", file=sys.stderr, flush=True)
            else:
                print(traceback.format_exc(), file=sys.stderr, flush=True)
            emit(
                {
                    "id": request_id,
                    "ok": False,
                    "errorCode": getattr(error, "code", "WORKER_TASK_FAILED"),
                    "errorMessage": str(error),
                }
            )

        # The server closes stdin only after accepting the response when a
        # recycle is requested. Waiting for EOF avoids an exit-vs-stdout race
        # where the process exit event could otherwise beat the final response.

    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    return runtime_check() if args.check else run_daemon()


if __name__ == "__main__":
    raise SystemExit(main())
