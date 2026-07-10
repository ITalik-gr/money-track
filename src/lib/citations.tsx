import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { highlightAmounts } from "./highlight.tsx";

// §5/§2: AI цитує конкретні операції токеном [tx:ID]. Рендеримо їх клікабельними чипами
// (→ /tx/:id), а решту тексту — через highlightAmounts (суми/відсотки). Спільно для
// репортів і порадника. Невідомий/битий токен просто зникає (не показуємо сирий [tx:…]).
const TX_RE = /\[tx:([A-Za-z0-9_-]+)\]/g;

export function renderRich(text: string | null | undefined): ReactNode[] {
  if (!text) return [];
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  TX_RE.lastIndex = 0;
  while ((m = TX_RE.exec(text)) !== null) {
    if (m.index > last) out.push(...highlightAmounts(text.slice(last, m.index)));
    out.push(
      <Link key={`tx-${i++}`} to={`/tx/${m[1]}`} className="tx-cite" title="Відкрити операцію">↗</Link>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(...highlightAmounts(text.slice(last)));
  return out;
}
