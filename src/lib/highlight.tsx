import type { ReactNode } from "react";

// Виділяє суми та відсотки (123 ₴, 45%, $12) у тексті AI (DESIGN.md §7 F6).
export function highlightAmounts(text: string): ReactNode[] {
  const re = /(\d[\d\s]*[.,]?\d*\s?(?:₴|грн|%|\$|€|EUR|USD|UAH))/gi;
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<span className="hl-amt" key={i++}>{m[0].trim()}</span>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
