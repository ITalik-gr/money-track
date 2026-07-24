import { useMemo, useState } from "react";
import { Select } from "./Select.tsx";
import { Icon } from "./Icon.tsx";
import { formatMinor, currencySign } from "../lib/format.ts";
import { toast } from "../lib/toast.ts";
import { useGetTxSplitsQuery, useSetTxSplitsMutation } from "../store/api.ts";
import type { Category } from "../../shared/types.ts";

// §SPLIT: поділ витрати на кілька категорій (напр. супермаркет: продукти + побутхімія).
// Суми в ГРН (позитивні), сходяться до |суми операції|; зберігаємо як від'ємні копійки.
type Row = { category_id: number | null; major: string };
const toMinor = (major: string) => Math.round(Number(major.replace(",", ".")) * 100) || 0;

export function TxSplitEditor({ txId, amount, currency, cats }: {
  txId: string; amount: number; currency: number; cats: Category[] | undefined;
}) {
  const { data: splits } = useGetTxSplitsQuery(txId);
  const [save, { isLoading }] = useSetTxSplitsMutation();
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);

  const totalMinor = Math.abs(amount);
  const sign = currencySign(currency);
  const catOptions = useMemo(
    () => (cats ?? []).map((c) => ({ value: c.id, label: c.parent_id ? `— ${c.name}` : c.name, color: c.color ?? undefined })),
    [cats],
  );
  const has = (splits?.length ?? 0) > 0;
  const sumMinor = rows.reduce((s, r) => s + toMinor(r.major), 0);
  const remainder = totalMinor - sumMinor;
  const noCat = rows.some((r) => r.category_id == null);
  const zeroRow = rows.some((r) => toMinor(r.major) <= 0);
  const valid = rows.length >= 2 && remainder === 0 && !noCat && !zeroRow;

  const major = (minor: number) => (Math.max(0, minor) / 100).toFixed(2);

  // Введення суми з автодоведенням: коли частин рівно дві, друга рахується сама — саме це
  // питання «скільки лишилось» користувач інакше мусить рахувати в голові. При трьох і більше
  // однозначної відповіді нема, тож там працює кнопка «решта» на конкретному рядку.
  function setAmount(i: number, value: string) {
    setRows((rs) => {
      const next = rs.map((x, j) => (j === i ? { ...x, major: value } : x));
      if (next.length === 2) {
        const other = i === 0 ? 1 : 0;
        next[other] = { ...next[other], major: major(totalMinor - toMinor(value)) };
      }
      return next;
    });
  }
  // Досипати весь незакритий залишок у конкретний рядок.
  function fillRest(i: number) {
    setRows((rs) => rs.map((x, j) => (j === i ? { ...x, major: major(toMinor(x.major) + remainder) } : x)));
  }
  // Повзунок доступний лише для двох частин: він фізично рухає одну межу, тож сума завжди
  // сходиться точно — на відміну від ручного вводу, де можна лишити «хвіст» у копійках.
  function slide(minorForFirst: number) {
    setRows((rs) => [
      { ...rs[0], major: major(minorForFirst) },
      { ...rs[1], major: major(totalMinor - minorForFirst) },
    ]);
  }

  function begin() {
    // Стартуємо з наявних частин або з одного рядка на всю суму + порожній.
    // Старт — рівно навпіл, а не «уся сума + порожньо»: так обидві частини одразу валідні,
    // сума вже сходиться, і лишається тільки посунути межу під реальність.
    if (has && splits) setRows(splits.map((s) => ({ category_id: s.category_id, major: (Math.abs(s.amount) / 100).toFixed(2) })));
    else {
      const half = Math.round(totalMinor / 2);
      setRows([
        { category_id: null, major: (half / 100).toFixed(2) },
        { category_id: null, major: ((totalMinor - half) / 100).toFixed(2) },
      ]);
    }
    setEditing(true);
  }
  async function commit(next: Row[] | null) {
    try {
      const payload = next === null ? [] : next.map((r) => ({ category_id: r.category_id as number, amount: -toMinor(r.major) }));
      await save({ id: txId, splits: payload }).unwrap();
      toast.success(next === null ? "Поділ прибрано" : "Операцію розділено");
      setEditing(false);
    } catch (e) {
      toast.error((e as { data?: { error?: string } })?.data?.error ?? "Не вдалося зберегти поділ");
    }
  }

  // Витрата, поділена — зведена картка (не в режимі редагування).
  if (has && !editing) {
    return (
      <div className="card split-card">
        <div className="section-head"><h3>Розділено на категорії</h3><button className="btn sm ghost" onClick={begin}>Редагувати</button></div>
        <div className="split-view">
          {splits!.map((s) => (
            <div className="split-vrow" key={s.id}>
              <span className="split-cat"><span className="d" style={{ background: s.category_color ?? "var(--muted)" }} />{s.category_name ?? "категорія"}</span>
              <span className="split-amt">{formatMinor(Math.abs(s.amount), { decimals: false })} {sign}</span>
            </div>
          ))}
        </div>
        <button className="btn sm ghost" style={{ marginTop: 10 }} onClick={() => commit(null)} disabled={isLoading}>Прибрати поділ</button>
      </div>
    );
  }

  if (!editing) {
    return (
      <div className="card split-card">
        <div className="split-empty">
          <div>
            <div className="split-empty-t">Розділити на категорії</div>
            <div className="split-empty-s">Одна покупка → кілька категорій (напр. продукти + побутхімія). Впливає на аналітику.</div>
          </div>
          <button className="btn sm" onClick={begin}><Icon name="swap" /> Розділити</button>
        </div>
      </div>
    );
  }

  return (
    <div className="card split-card">
      <div className="section-head"><h3>Поділ на категорії</h3></div>
      <div className="split-rows">
        {rows.map((r, i) => (
          <div className="split-row" key={i}>
            <Select
              value={r.category_id}
              options={catOptions}
              onChange={(v) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, category_id: v == null ? null : Number(v) } : x)))}
              placeholder="категорія"
              searchable
            />
            <div className="split-amt-in">
              <input inputMode="decimal" value={r.major} placeholder="0.00"
                onChange={(e) => setAmount(i, e.target.value)} />
              <span className="split-sign">{sign}</span>
              {remainder !== 0 && rows.length > 2 && (
                <button type="button" className="split-rest" onClick={() => fillRest(i)}
                  title={`Досипати сюди залишок ${formatMinor(remainder, { decimals: false })} ${sign}`}>решта</button>
              )}
            </div>
            <button className="btn sm icon ghost" aria-label="Прибрати" disabled={rows.length <= 2}
              onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}><Icon name="trash" /></button>
          </div>
        ))}
      </div>

      {/* Дві частини — повзунок: тягнеш межу, обидві суми рахуються самі й завжди сходяться. */}
      {rows.length === 2 && (
        <div className="split-slider">
          <input type="range" min={0} max={totalMinor} step={10} value={Math.min(totalMinor, Math.max(0, toMinor(rows[0].major)))}
            onChange={(e) => slide(Number(e.target.value))} aria-label="Пропорція поділу" />
          <div className="split-slider-marks">
            <button type="button" onClick={() => slide(Math.round(totalMinor / 2))}>50 / 50</button>
            <button type="button" onClick={() => slide(Math.round(totalMinor * 0.7))}>70 / 30</button>
            <button type="button" onClick={() => slide(Math.round(totalMinor / 3))}>⅓ / ⅔</button>
          </div>
        </div>
      )}

      <button className="btn sm ghost" onClick={() => setRows((rs) => [...rs, { category_id: null, major: "" }])}><Icon name="plus" /> Додати частину</button>

      {/* Статус мусить відповідати РЕАЛЬНІЙ готовності, а не лише залишку: раніше «✓ сходиться»
          світилось зеленим при частині на 0.00 без категорії — тобто зберегти було не можна,
          а індикатор казав «усе добре». */}
      <div className={`split-remainder ${valid ? "ok" : ""}`}>
        {remainder !== 0
          ? `Лишилось розподілити ${formatMinor(remainder, { decimals: false })} ${sign} із ${formatMinor(totalMinor, { decimals: false })} ${sign}`
          : zeroRow ? "Є частина з нульовою сумою — прибери її або впиши суму"
          : noCat ? "Обери категорію в кожній частині"
          : "✓ сходиться"}
      </div>
      <div className="split-actions">
        <button className="btn sm ghost" onClick={() => setEditing(false)}>Скасувати</button>
        <button className="btn sm primary" disabled={!valid || isLoading} onClick={() => commit(rows)}>Зберегти поділ</button>
      </div>
    </div>
  );
}
