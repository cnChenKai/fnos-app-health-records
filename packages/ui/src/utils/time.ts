const localDateTimeOptions: Intl.DateTimeFormatOptions = {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit"
};

const localDateTimeWithYearOptions: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit"
};

function parseDatabaseTimestamp(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const normalized = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
  return new Date(hasTimezone ? normalized : `${normalized}Z`);
}

export function formatDatabaseTime(value: string | null | undefined, empty = "—") {
  return formatDatabaseTimeWith(value, localDateTimeOptions, empty);
}

export function formatDatabaseTimeWithYear(value: string | null | undefined, empty = "—") {
  return formatDatabaseTimeWith(value, localDateTimeWithYearOptions, empty);
}

function formatDatabaseTimeWith(value: string | null | undefined, options: Intl.DateTimeFormatOptions, empty: string) {
  if (!value) return empty;
  const date = parseDatabaseTimestamp(value);
  if (!date || Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", options);
}
