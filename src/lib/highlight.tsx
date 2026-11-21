import type { ReactNode } from "react";
import { numFmt } from "../i18n/locale.ts";
import { splitAmounts } from "./amount-spans.ts";

// The model writes raw digits (18763₴); regroup them by the same rule as `formatMinor`, or figures
// in reports look different from everywhere else. Fraction length is kept: 0.0345 BTC is not 0.03.
function reformatNumber(input: string): string {
  const grouped = /^[1-9]\d{0,2}(?:,\d{3})+\.\d+$|^[1-9]\d{0,2}(?:,\d{3}){2,}(?:\.\d+)?$/.test(input);
  const raw = grouped ? input.replace(/,/g, "") : input;
  const m = raw.trim().match(/^([\d\s]+)(?:[.,](\d{1,8}))?$/);
  if (!m) return raw;
  const intDigits = m[1].replace(/\s/g, "");
  const frac = m[2];
  const n = Number(`${intDigits}.${frac ?? 0}`);
  if (!Number.isFinite(n)) return raw;
  const digits = frac?.length ?? 0;
  return numFmt({ minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
}

// Highlights sums, ranges and percentages in AI text (DESIGN.md §7 F6).
export function highlightAmounts(text: string): ReactNode[] {
  return splitAmounts(text, reformatNumber).map((s, i) =>
    s.amount ? <span className="hl-amt" key={i}>{s.text}</span> : s.text);
}
