import type { TrendSeries } from "../types/api";

export function normalizedTrendSearch(value: string | null | undefined) {
  return (value || "").normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\s+/g, "");
}

export function matchTrendSearch(item: Pick<TrendSeries, "name" | "searchAliases">, query: string) {
  const keyword = normalizedTrendSearch(query);
  if (!keyword) return { matches: true, alias: null as string | null };
  if (normalizedTrendSearch(item.name).includes(keyword)) return { matches: true, alias: null as string | null };
  const alias = item.searchAliases.find((value) => normalizedTrendSearch(value).includes(keyword)) || null;
  return { matches: Boolean(alias), alias };
}

