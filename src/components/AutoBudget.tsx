// Автобюджет із історії — детерміновано, без AI і без чату.
// «Ліміти = мій звичний рівень мінус N%». Поруч живе AI-план: той пояснює й враховує
// профіль, цей — миттєвий, безкоштовний і передбачуваний. Різні інструменти, обидва потрібні.
import { useState } from "react";
import { useLazyGetAutoBudgetQuery, useApplyAutoBudgetMutation } from "../store/api.ts";
import type { AutoBudgetItem } from "../store/api.ts";
import { Money } from "./Money.tsx";
import { Icon } from "./Icon.tsx";
import { ErrorNote } from "./ErrorNote.tsx";
import { toast } from "../lib/toast.ts";
import { errText } from "../lib/errors.ts";

const TRIMS = [0, 5, 10, 15, 20];

export function AutoBudget() {
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
      toast.success(`Оновлено конвертів: ${r.applied}`);
    } catch (e) { toast.error(errText(e)); }
  }

  return (
    <section>
      <div className="section-head">
        <h2>Автобюджет із історії</h2>
        <button className="btn sm" onClick={() => run(trim)} disabled={isFetching}>
          <Icon name="repeat" size={15} />{isFetching ? "Рахую…" : data ? "Перерахувати" : "Порахувати"}
        </button>
      </div>

      <ErrorNote error={error} what="автобюджет" onRetry={() => run(trim)} />

      {!data && !isFetching && !error && (
        <div className="card empty">
          Візьме твій звичний місячний рівень по кожній категорії й запропонує ліміт трохи нижчий.
          Без AI — миттєво й безкоштовно.
        </div>
      )}

      {data && (
        <div className="card" style={{ padding: 16 }}>
          <div className="ab-trim">
            <span className="label">Зрізати від звичного</span>
            <div className="seg">
              {TRIMS.map((t) => (
                <button key={t} className={`seg-btn ${trim === t ? "active" : ""}`} onClick={() => run(t)} disabled={isFetching}>
                  {t === 0 ? "як є" : `−${t}%`}
                </button>
              ))}
            </div>
          </div>

          <p className="ab-hint">
            Обовʼязкові категорії (оренда, продукти, ліки) не ріжемо — ліміт по них дорівнює
            звичному рівню. Урізати те, що не можна урізати, означає завести бюджет,
            який червонітиме з першого дня.
          </p>

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
                      {i.essential && <span className="ab-tag">обовʼязкова</span>}
                    </span>
                    <span className="bp-figs">
                      <span className="bp-avg">звично <Money minor={i.level} decimals={false} /></span>
                      <span className="bp-arrow">→</span>
                      <span className="bp-sug"><Money minor={i.suggested} decimals={false} /></span>
                      {delta !== 0 && <span className={`cmp-delta ${delta < 0 ? "down" : "up"}`}>{delta > 0 ? "+" : ""}{delta}%</span>}
                    </span>
                  </div>
                  {/* Наявний ліміт показуємо явно: застосування його ПЕРЕЗАПИШЕ, і про це
                      треба знати до кліку, а не після. */}
                  {i.current != null && i.current !== i.suggested && (
                    <div className="bp-reason">зараз стоїть <Money minor={i.current} decimals={false} /> — буде замінено</div>
                  )}
                </label>
              );
            })}
          </div>

          {items.length === 0 && <div className="empty">Замало історії, щоб порахувати рівні по категоріях.</div>}

          {picked.length > 0 && (
            <div className="ab-foot">
              <span className="ab-total">
                Разом на місяць: <b><Money minor={total} decimals={false} /></b>
                <span className="muted"> · {picked.length} з {items.length} категорій</span>
              </span>
              <button className="btn primary" onClick={save} disabled={applying}>
                {applying ? "Застосовую…" : "Застосувати"}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
