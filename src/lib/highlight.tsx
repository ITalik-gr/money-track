import type { ReactNode } from "react";
import { getLocale, localeTag } from "../i18n/locale.ts";

// AI пише суми "сирими" цифрами без розділювачів (18763₴) — перегруповуємо за тим самим
// правилом, що й formatMinor, інакше цифри в репортах/пораднику виглядають інакше, ніж скрізь.
function reformatNumber(raw: string): string {
  const m = raw.trim().match(/^([\d\s]+)(?:[.,](\d{1,2}))?$/);
  if (!m) return raw;
  const intDigits = m[1].replace(/\s/g, "");
  const frac = m[2];
  const n = Number(intDigits) + (frac ? Number(frac) / 10 ** frac.length : 0);
  if (!Number.isFinite(n)) return raw;
  return new Intl.NumberFormat(localeTag(getLocale()), { minimumFractionDigits: frac ? 2 : 0, maximumFractionDigits: frac ? 2 : 0 }).format(n);
}

// Виділяє суми та відсотки (123 ₴, 45%, $12) у тексті AI (DESIGN.md §7 F6).
export function highlightAmounts(text: string): ReactNode[] {
  const re = /(\d[\d\s]*(?:[.,]\d{1,2})?)(\s?(?:₴|грн|%|\$|€|EUR|USD|UAH))/gi;
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<span className="hl-amt" key={i++}>{reformatNumber(m[1])}{m[2]}</span>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
