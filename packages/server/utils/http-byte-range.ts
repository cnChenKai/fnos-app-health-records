export type ByteRangeResolution =
  | { kind: "full" }
  | { kind: "partial"; start: number; end: number; length: number }
  | { kind: "unsatisfiable" };

function safeByteOffset(value: string) {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function resolveSingleByteRange(
  value: string | undefined,
  totalSize: number,
): ByteRangeResolution {
  if (!value) return { kind: "full" };
  if (!Number.isSafeInteger(totalSize) || totalSize <= 0 || value.includes(",")) {
    return { kind: "unsatisfiable" };
  }

  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return { kind: "unsatisfiable" };

  if (!match[1]) {
    const suffixLength = safeByteOffset(match[2]);
    if (!suffixLength) return { kind: "unsatisfiable" };
    const length = Math.min(suffixLength, totalSize);
    return {
      kind: "partial",
      start: totalSize - length,
      end: totalSize - 1,
      length,
    };
  }

  const start = safeByteOffset(match[1]);
  const requestedEnd = match[2] ? safeByteOffset(match[2]) : totalSize - 1;
  if (start === null || requestedEnd === null || start >= totalSize || requestedEnd < start) {
    return { kind: "unsatisfiable" };
  }
  const end = Math.min(requestedEnd, totalSize - 1);
  return { kind: "partial", start, end, length: end - start + 1 };
}
