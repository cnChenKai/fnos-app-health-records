# OCR Worker

The worker runs PP-OCRv4 mobile through RapidOCR. x86 environments prefer the
OpenVINO CPU backend; ARM64 environments use ONNXRuntime because repeated
OpenVINO inference can exhaust container memory even when a one-shot smoke test
passes.
It is a single long-lived Python process controlled by the Nitro server through
newline-delimited JSON.

Development setup:

```bash
sh packages/ocr-worker/setup-runtime.sh
```

The virtual environment is stored in `.data/ocr-venv` and is intentionally not
bundled in the application package. On fnOS, run the packaged setup script with
`STORAGE_DIR=/var/apps/fnos-app-health-records/var/data` after a compatible
Python 3.9-3.12 runtime is available.

The target Intel J4105 device must be validated before release. Development on
Apple Silicon does not verify x86 instruction compatibility or J4105 latency.

## Large report memory lifecycle

For large reports, each successful worker response includes RSS and request-count
metadata. The worker exits cleanly after the report boundary, after 32 OCR
requests, or when RSS reaches 1.5 GiB. The server accepts the completed response
before retiring that process, so the next queued page starts in a fresh worker
without retrying or duplicating the completed page.

The safety boundaries can be adjusted for unusually small or large NAS devices:

- `OCR_WORKER_MAX_OCR_REQUESTS_PER_PROCESS`
- `OCR_WORKER_MAX_RSS_BYTES`

## Long-running request liveness

The worker emits an NDJSON heartbeat while OCR, PDF inspection, or thumbnail
work is still running. Heartbeats indicate process responsiveness; they do not
claim that a page has completed or expose partial OCR results. The server uses
them to distinguish a slow CPU-bound page from a silent worker:

- `OCR_WORKER_HEARTBEAT_INTERVAL_MS` controls the worker heartbeat interval
  (default 15 seconds).
- `OCR_WORKER_TIMEOUT_MS` controls how long the server accepts no heartbeat or
  final response before replacing the worker (default 2 minutes).
- `OCR_WORKER_HARD_TIMEOUT_MS` is the absolute per-request ceiling even when
  heartbeats continue (default 30 minutes), so a process that is alive but never
  finishes cannot starve later household reports.

OCR requests remain serialized, so this protection does not add parallel OCR
CPU pressure. Processing-job leases are renewed for local OCR/PDF/thumbnail
jobs as well as AI jobs while they are running; this prevents a slow page from
being recovered and executed twice by another runner.
