import { useMemo } from "react";
import { numFmt } from "../../i18n/locale.ts";
import { highlightAmounts } from "../../lib/highlight.tsx";
import { useGetCategoriesQuery } from "../../store/api.ts";
import type { AiFact } from "../../store/api.ts";
import { baseSign } from "../../lib/currency.ts";

// Стилізований рендер структурованого AI-виводу: headline + факти (суми/категорії/
// дельти виділені) + порада. Спільний для інсайту й порад (DESIGN.md §7 F6).
const fmt0 = numFmt({ maximumFractionDigits: 0 });

export function RichFacts({ headline, facts, note }: { headline?: string; facts?: AiFact[]; note?: string | null }) {
  // Колір категорії тягнемо з реальних категорій за назвою (AI дає лише назву).
  const { data: cats } = useGetCategoriesQuery();
  const colorByName = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of cats ?? []) if (c.color) m.set(c.name.toLowerCase(), c.color);
    return m;
  }, [cats]);

  return (
    <div className="rich">
      {headline && <div className="rich-headline">{headline}</div>}
      {facts && facts.length > 0 && (
        <div className="rich-facts">
          {facts.map((f, i) => {
            const catColor = f.category ? colorByName.get(f.category.toLowerCase()) : undefined;
            const hasVal = f.category || f.amount != null || f.delta_pct != null;
            return (
              <div className="fact-row" key={i}>
                <span className="fact-label">{f.label}</span>
                <span className="fact-vals">
                  {f.category && (
                    <span className="fact-cat">
                      {catColor && <span className="fact-cat-dot" style={{ background: catColor }} />}
                      {f.category}
                    </span>
                  )}
                  {f.amount != null && <span className={`fact-amt ${f.tone ?? "neutral"}`}>{fmt0.format(f.amount)} {baseSign()}</span>}
                  {f.delta_pct != null && (
                    <span className="fact-delta">{f.delta_pct >= 0 ? "+" : ""}{f.delta_pct}%</span>
                  )}
                  {/* Факт без числового значення (напр. «Runway на burn») не лишаємо порожнім рядком. */}
                  {!hasVal && <span className="fact-amt muted-dash">—</span>}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {note && <p className="rich-note">{highlightAmounts(note)}</p>}
    </div>
  );
}
