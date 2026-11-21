/**
 * Parses the model's `[chart:TYPE|Title]` block. Pure, so the worker test runner can pin it.
 * `[chart:Title]` predates the type and is stored in old answers, so it stays a bar chart.
 */
export type ChartType = "bar" | "column" | "line" | "area" | "donut";
export interface ParsedChart {
  type: ChartType;
  title: string | null;
  series: string[];
  rows: { label: string; values: number[] }[];
}

const TYPES = new Set<string>(["bar", "column", "line", "area", "donut"]);
const MAX_ROWS = 24;
const MAX_SERIES = 3;

/** A bare figure, tolerating what models add anyway («12 500 ₴», «−300», «1,5»). */
function toNumber(raw: string): number | null {
  const s = raw.replace(/[\s  ]/g, "").replace("−", "-").replace(",", ".").replace(/[^\d.-]/g, "");
  if (!/\d/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function parseChart(head: string | undefined, lines: string[]): ParsedChart | null {
  const h = head?.trim() ?? "";
  const bar = h.indexOf("|");
  const tag = bar > 0 ? h.slice(0, bar).trim().toLowerCase() : "";
  const type = (TYPES.has(tag) ? tag : "bar") as ChartType;
  const title = (TYPES.has(tag) ? h.slice(bar + 1) : h).trim() || null;

  const cells = lines.map((l) => l.split("|").map((c) => c.trim())).filter((c) => c.length >= 2 && c[0]);
  const multi = cells[0]?.[0] === "#" && type !== "bar" && type !== "donut";
  const series = multi ? cells[0].slice(1, MAX_SERIES + 1) : [title ?? ""];
  const rows: ParsedChart["rows"] = [];
  for (const c of cells.slice(cells[0]?.[0] === "#" ? 1 : 0, MAX_ROWS + 1)) {
    const values = c.slice(1, series.length + 1).map(toNumber);
    // A row with a missing value is dropped: drawing it as 0 would state a figure nobody gave.
    if (values.length === series.length && values.every((v) => v != null)) rows.push({ label: c[0], values: values as number[] });
  }
  if (!rows.length) return null;
  // Shares of a whole cannot be negative; such data is a comparison, so it is drawn as one.
  const safeType = type === "donut" && rows.some((r) => r.values[0] < 0) ? "bar" : type;
  return { type: safeType, title, series, rows };
}
