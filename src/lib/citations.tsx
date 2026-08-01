import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { highlightAmounts } from "./highlight.tsx";
import { translate } from "../i18n/index.ts";
import { getLocale } from "../i18n/locale.ts";

// §5/§2: AI цитує конкретні операції токеном [tx:ID]. Рендеримо їх клікабельними чипами
// (→ /tx/:id), а решту тексту — через highlightAmounts (суми/відсотки). Спільно для
// репортів і порадника. Невідомий/битий токен просто зникає (не показуємо сирий [tx:…]).
const TX_RE = /\[tx:([A-Za-z0-9_-]+)\]/g;

/**
 * Те саме, але БЕЗ посилань — для прев'ю всередині елемента, який сам є посиланням.
 *
 * Картка звіту в списку — це `<Link>`, а вкладений `<a>` у `<a>` невалідний: React його
 * відрендерить, браузер розірве, і клік по картці стане непередбачуваним. Тому тут токен
 * `[tx:ID]` просто зникає (як і битий токен у `renderRich`), а суми й відсотки далі
 * підсвічуються — без цього в списку висіли сирі `[tx:2jiKO6RV5t51i-jMSA]` на пів-рядка,
 * і прев'ю читалось як зламане.
 */
export function renderRichPlain(text: string | null | undefined): ReactNode[] {
  if (!text) return [];
  // Прибираємо токен разом із пробілом ПЕРЕД ним, інакше лишається «Rozetka  і далі» з дірою.
  return highlightAmounts(text.replace(/\s*\[tx:[A-Za-z0-9_-]+\]/g, ""));
}

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
      <Link key={`tx-${i++}`} to={`/tx/${m[1]}`} className="tx-cite" title={translate(getLocale(), "citations.openTxTitle")}>↗</Link>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(...highlightAmounts(text.slice(last)));
  return out;
}
