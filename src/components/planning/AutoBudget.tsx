// Автобюджет із історії — детерміновано, без AI і без чату.
// «Ліміти = мій звичний рівень мінус N%». Поруч живе AI-план: той пояснює й враховує
// профіль, цей — миттєвий, безкоштовний і передбачуваний. Різні інструменти, обидва потрібні.
import { useState } from "react";
import { useLazyGetAutoBudgetQuery, useApplyAutoBudgetMutation } from "../../store/api.ts";
import type { AutoBudgetItem } from "../../store/api.ts";
import { Money } from "../ui/Money.tsx";
import { Icon } from "../ui/Icon.tsx";
import { ErrorNote } from "../ui/ErrorNote.tsx";
import { toast } from "../../lib/toast.ts";
import { errText } from "../../lib/errors.ts";
import { useT } from "../../i18n/index.ts";

const TRIMS = [0, 5, 10, 15, 20];

export function AutoBudget() {
  const tr = useT();
  const [load, { data, isFetching, error }] = useLazyGetAutoBudgetQuery();
  const [apply, { isLoading: applying }] = useApplyAutoBudgetMutation();
  const [trim, setTrim] = useState(10);
  // Знятий чекбокс = «цю категорію не чіпай». Тримаємо ВИКЛЮЧЕНІ, а не включені:
  // за замовчуванням пропозиція застосовується вся, і список не треба ініціалізувати.
  const [off, setOff] = useState<Set<number>>(new Set());

  const items = data?.items ?? [];
  const picked = items.filter((i) => !off.has(i.category_id));
  const total = picked.reduce((s, i) => s + i.suggested, 0);

  const run = (t: number) => { setTrim(t); setOff(new Set()); void load({ trim: t }); };

  const toggle = (id: number) => setOff((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  async function save() {
    if (!picked.length) return;
    try {
      const r = await apply({ items: picked.map((i) => ({ category_id: i.category_id, amount: i.suggested })) }).unwrap();
      toast.success(tr("ab.updatedEnvelopesToast", { n: r.applied }));
    } catch (e) { toast.error(errText(e)); }
  }

  return (
    <section>
      <div className="section-head">
        <h2>{tr("ab.title")}</h2>
        <button className="btn sm" onClick={() => run(trim)} disabled={isFetching}>
          <Icon name="repeat" size={15} />{isFetching ? tr("ab.calculating") : data ? tr("ab.recalculate") : tr("ab.calculate")}
        </button>
      </div>

      <ErrorNote error={error} what={tr("ab.errorWhat")} onRetry={() => run(trim)} />

      {!data && !isFetching && !error && (
        <div className="card empty">{tr("ab.introText")}</div>
      )}

      {data && (
        <div className="card" style={{ padding: 16 }}>
          <div className="ab-trim">
            <span className="label">{tr("ab.trimLabel")}</span>
            <div className="seg">
              {TRIMS.map((v) => (
                <button key={v} className={`seg-btn ${trim === v ? "active" : ""}`} onClick={() => run(v)} disabled={isFetching}>
                  {v === 0 ? tr("ab.trimAsIs") : `−${v}%`}
                </button>
              ))}
            </div>
          </div>

          <p className="ab-hint">{tr("ab.essentialHint")}</p>

          <div className="bp-list">
            {items.map((i: AutoBudgetItem) => {
              const on = !off.has(i.category_id);
              const delta = i.level > 0 ? Math.round(((i.suggested - i.level) / i.level) * 100) : 0;
              return (
                <label className={`bp-item ab-item ${on ? "" : "off"}`} key={i.category_id}>
                  <input type="checkbox" checked={on} onChange={() => toggle(i.category_id)} />
                  <div className="bp-item-main">
                    <span className="bp-name">
                      <span className="d" style={{ background: i.color ?? "var(--muted)" }} />
                      {i.name}
                      {i.essential && <span className="ab-tag">{tr("ab.essentialTag")}</span>}
                    </span>
                    <span className="bp-figs">
                      <span className="bp-avg">{tr("ab.usualPrefix")} <Money minor={i.level} decimals={false} /></span>
                      <span className="bp-arrow">→</span>
                      <span className="bp-sug"><Money minor={i.suggested} decimals={false} /></span>
                      {delta !== 0 && <span className={`cmp-delta ${delta < 0 ? "down" : "up"}`}>{delta > 0 ? "+" : ""}{delta}%</span>}
                    </span>
                  </div>
                  {/* Наявний ліміт показуємо явно: застосування його ПЕРЕЗАПИШЕ, і про це
                      треба знати до кліку, а не після. */}
                  {i.current != null && i.current !== i.suggested && (
                    <div className="bp-reason">{tr("ab.currentPrefix")} <Money minor={i.current} decimals={false} />{tr("ab.willBeReplaced")}</div>
                  )}
                </label>
              );
            })}
          </div>

          {items.length === 0 && <div className="empty">{tr("ab.notEnoughHistory")}</div>}

          {picked.length > 0 && (
            <div className="ab-foot">
              <span className="ab-total">
                {tr("ab.totalPerMonth")} <b><Money minor={total} decimals={false} /></b>
                <span className="muted">{tr("ab.countOfTotal", { picked: picked.length, total: items.length })}</span>
              </span>
              <button className="btn primary" onClick={save} disabled={applying}>
                {applying ? tr("ab.applying") : tr("common.apply")}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
