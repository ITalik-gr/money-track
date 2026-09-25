/**
 * §QUERY-PARSE — the search box understands what a person types.
 *
 * «кава понад 200 у травні без Starbucks» used to be searched as ONE substring and found nothing.
 * The filters it describes all existed (amount bounds, dates, type, category) behind a panel; the
 * box simply could not reach them. This parser turns such text into those same filters, BEFORE any
 * vector is touched (§SEARCH-VEC stays the fallback for whatever text is left).
 *
 * Rules that keep it honest:
 *  · a parser never WIDENS a result silently: every recognised piece becomes a visible chip the
 *    person can remove, and every unrecognised word stays in the free text — nothing is dropped;
 *  · periods are Kyiv calendar periods (§APP_TZ) through `time.ts` — never `new Date().getMonth()`;
 *  · a month without a year is its most recent occurrence that is not in the future;
 *  · category names are matched in JS, where Cyrillic case folds (§CYR-CASE), in the reader's
 *    language (the caller passes names resolved through `catNameSql`);
 *  · amounts are whole units of the row's own currency, like the panel's `amin`/`amax`.
 *
 * Pure: no database — a phrase can be pinned by a unit test without a fixture.
 */
import type { ParsedQuery, ParsedQueryChip } from "../../../shared/api/transactions.ts";
import {
  localParts, localWallTime, localDayStart, localWeekStart, localMonthStart, localQuarterStart, localYearStart,
} from "./time.ts";
import { BASE_CURRENCIES, currencySign, currencyCode } from "../../../shared/currency.ts";

export interface ParseCategory { id: number; name: string; parent_id: number | null }

// Word boundaries that work for Cyrillic: JS `\b` is ASCII-only, exactly like SQLite's LOWER.
const L = "(?<![\\p{L}\\p{N}])";
const R = "(?![\\p{L}\\p{N}])";
// Currency marks accepted after a number: the symbols from the ONE currency table (C10), their ISO
// letters, and «грн». They only let «500 грн» parse as 500 — the amount is still the row's own.
const CUR_MARKS = [
  ...BASE_CURRENCIES.map((c) => escapeRe(currencySign(c))),
  ...BASE_CURRENCIES.map((c) => currencyCode(c).toLowerCase()),
  "грн\\.?",
].join("|");
const NUM = `(\\d[\\d\\s]*(?:[.,]\\d+)?)(?:\\s*(?:${CUR_MARKS})(?![\\p{L}]))?`;

const MONTHS: [RegExp, number][] = [
  [/січ(?:ень|ня|ні)|january/u, 1], [/лют(?:ий|ого|ому)|february/u, 2], [/берез(?:ень|ня|ні)|march/u, 3],
  [/квіт(?:ень|ня|ні)|april/u, 4], [/трав(?:ень|ня|ні)|may/u, 5], [/черв(?:ень|ня|ні)|june/u, 6],
  [/лип(?:ень|ня|ні)|july/u, 7], [/серп(?:ень|ня|ні)|august/u, 8], [/верес(?:ень|ня|ні)|september/u, 9],
  [/жовт(?:ень|ня|ні)|october/u, 10], [/листопад(?:а|і)?|november/u, 11], [/груд(?:ень|ня|ні)|december/u, 12],
];
const MONTH_ALT = MONTHS.map(([re]) => re.source).join("|");

const STOP = new Set(["на", "в", "у", "за", "з", "і", "та", "й", "для", "по", "for", "on", "in", "at", "and", "the", "of"]);

const toNum = (s: string) => Number(s.replace(/\s/g, "").replace(",", "."));

/** The first day of month `m` (1-12) of year `y`, and the first day of the next, in Kyiv. */
function monthBounds(y: number, m: number): [number, number] {
  const from = localWallTime(y, m, 1);
  return [from, localMonthStart(from, 1) - 1];
}

export function parseQuery(input: string, categories: ParseCategory[], now: number): ParsedQuery {
  let rest = ` ${input.trim()} `;
  const out: ParsedQuery = { text: null, exclude: [], chips: [] };
  const chip = (kind: ParsedQueryChip["kind"], raw: string) => out.chips.push({ kind, raw: raw.trim() });
  /** Match once, record, and cut the matched span out of the text. */
  const take = (re: RegExp, on: (m: RegExpExecArray) => ParsedQueryChip["kind"] | null) => {
    const m = re.exec(rest);
    if (!m) return;
    const kind = on(m);
    if (!kind) return;
    chip(kind, m[0]);
    rest = rest.slice(0, m.index) + " " + rest.slice(m.index + m[0].length);
  };

  // ---- exclusions first: «без Starbucks» must not leave «Starbucks» as a search term ----
  for (let guard = 0; guard < 4; guard++) {
    const before = out.exclude.length;
    take(new RegExp(`${L}(?:без|крім|окрім|except|without)\\s+([\\p{L}\\d][\\p{L}\\d.'’&-]*)`, "iu"), (m) => {
      out.exclude.push(m[1]); return "exclude";
    });
    take(new RegExp(`(?:^|\\s)-([\\p{L}][\\p{L}\\d.'’&-]*)`, "u"), (m) => { out.exclude.push(m[1]); return "exclude"; });
    if (out.exclude.length === before) break;
  }

  // ---- amounts ----
  take(new RegExp(`${L}${NUM}\\s*(?:-|–|—|\\.\\.)\\s*${NUM}`, "iu"), (m) => {
    const a = toNum(m[1]), b = toNum(m[2]);
    if (!(a >= 0 && b >= 0)) return null;
    out.amin = Math.min(a, b); out.amax = Math.max(a, b); return "amount";
  });
  if (out.amin === undefined) {
    take(new RegExp(`(?:${L}(?:понад|більше(?:\\s+(?:за|ніж))?|більш\\s+ніж|від|over|more\\s+than|above|from)|>=?|≥)\\s*${NUM}(?![\\d])(?!\\s*(?:${MONTH_ALT}))`, "iu"), (m) => {
      out.amin = toNum(m[1]); return "amount";
    });
  }
  if (out.amax === undefined) {
    take(new RegExp(`(?:${L}(?:менше(?:\\s+(?:за|ніж))?|до|under|below|less\\s+than|up\\s+to)|<=?|≤)\\s*${NUM}(?![\\d])(?!\\s*(?:${MONTH_ALT}))`, "iu"), (m) => {
      out.amax = toNum(m[1]); return "amount";
    });
  }

  // ---- periods ----
  const setPeriod = (from: number, to: number) => { out.from = from; out.to = to; return "period" as const; };
  const relative: [string, () => [number, number]][] = [
    ["сьогодні|today", () => [localDayStart(now), now]],
    ["вчора|yesterday", () => [localDayStart(now, -1), localDayStart(now) - 1]],
    ["(?:цього|цей)\\s+тижн[яь]|цього\\s+тижня|this\\s+week", () => [localWeekStart(now), now]],
    ["(?:минулого|минулий)\\s+тижн(?:я|ь|ень)|last\\s+week", () => [localWeekStart(now, -1), localWeekStart(now) - 1]],
    ["(?:цього|цей)\\s+місяц[яь]|this\\s+month", () => [localMonthStart(now), now]],
    ["(?:минулого|минулий)\\s+місяц[яь]|last\\s+month", () => [localMonthStart(now, -1), localMonthStart(now) - 1]],
    ["(?:цього|цей)\\s+квартал[уа]?|this\\s+quarter", () => [localQuarterStart(now), now]],
    ["(?:минулого|минулий)\\s+квартал[уа]?|last\\s+quarter", () => [localQuarterStart(now, -1), localQuarterStart(now) - 1]],
    ["(?:цього|цей)\\s+(?:року|рік)|this\\s+year", () => [localYearStart(now), now]],
    ["(?:минулого|минулий)\\s+(?:року|рік)|last\\s+year", () => [localYearStart(now, -1), localYearStart(now) - 1]],
  ];
  for (const [src, bounds] of relative) {
    if (out.from !== undefined) break;
    take(new RegExp(`${L}(?:(?:за|у|в|in|during)\\s+)?(?:${src})${R}`, "iu"), () => setPeriod(...bounds()));
  }
  if (out.from === undefined) {
    take(new RegExp(`${L}(?:(?:у|в|за|in|during)\\s+)?(${MONTH_ALT})(?:\\s+(20\\d\\d))?(?:\\s*(?:року|р\\.))?${R}`, "iu"), (m) => {
      const word = m[1].toLowerCase();
      const month = MONTHS.find(([re]) => new RegExp(`^(?:${re.source})$`, "u").test(word))?.[1];
      if (!month) return null;
      const cur = localParts(now);
      // No year: the most recent such month that is not in the future.
      const y = m[2] ? Number(m[2]) : (month > cur.m ? cur.y - 1 : cur.y);
      return setPeriod(...monthBounds(y, month));
    });
  }
  if (out.from === undefined) {
    take(new RegExp(`${L}(?:у|в|за|in|during)\\s+(20\\d\\d)(?:\\s*(?:році|рік|року|р\\.))?${R}`, "iu"), (m) => {
      const y = Number(m[1]);
      const from = localWallTime(y, 1, 1);
      return setPeriod(from, localYearStart(from, 1) - 1);
    });
  }

  // ---- flow ----
  take(new RegExp(`${L}(?:доход(?:и|ів)?|дохід|надходження|income|incoming)${R}`, "iu"), () => { out.type = "income"; return "type"; });
  if (!out.type) take(new RegExp(`${L}(?:витрат[иа]?|spending|expenses)${R}`, "iu"), () => { out.type = "expense"; return "type"; });

  // ---- category: the LONGEST name that appears as whole words, Cyrillic-folded ----
  const folded = rest.toLocaleLowerCase("uk");
  let best: { c: ParseCategory; start: number; len: number } | null = null;
  for (const c of categories) {
    const name = c.name.trim().toLocaleLowerCase("uk");
    if (name.length < 3) continue;
    // A single long word also matches its inflected forms («продуктах» → «Продукти»): the stem is
    // the name minus up to two trailing letters, never shorter than four.
    const stem = !name.includes(" ") && name.length >= 5 ? name.slice(0, Math.max(4, name.length - 2)) : null;
    const re = stem
      ? new RegExp(`${L}${escapeRe(stem)}[\\p{L}]{0,4}${R}`, "u")
      : new RegExp(`${L}${escapeRe(name)}${R}`, "u");
    const m = re.exec(folded);
    if (m && (!best || m[0].length > best.len)) best = { c, start: m.index, len: m[0].length };
  }
  if (best) {
    const raw = rest.slice(best.start, best.start + best.len);
    if (best.c.parent_id == null) out.catparent = best.c.id; else out.category = best.c.id;
    chip("category", raw);
    rest = rest.slice(0, best.start) + " " + rest.slice(best.start + best.len);
  }

  const words = rest.split(/\s+/).filter(Boolean);
  const meaningful = words.filter((w) => !STOP.has(w.toLocaleLowerCase("uk")));
  out.text = meaningful.length ? words.join(" ") : null;
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
