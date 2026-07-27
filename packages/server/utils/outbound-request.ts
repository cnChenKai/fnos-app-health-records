type TimeoutFetchOptions = {
  timeoutMs: number;
  timeoutCode: string;
  timeoutMessage: string;
  networkCode: string;
  networkMessage: string;
};

export function configuredRequestTimeout(name: string, fallbackMs: number) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallbackMs;
  return Math.min(10 * 60_000, Math.max(5_000, Math.round(value)));
}

export async function fetchWithTimeout(url: string | URL, init: RequestInit, options: TimeoutFetchOptions) {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(options.timeoutMs)
    });
  } catch (cause) {
    const name = cause instanceof Error ? cause.name : "";
    const timedOut = name === "TimeoutError" || name === "AbortError";
    throw Object.assign(
      new Error(timedOut ? options.timeoutMessage : options.networkMessage),
      { code: timedOut ? options.timeoutCode : options.networkCode, cause }
    );
  }
}
