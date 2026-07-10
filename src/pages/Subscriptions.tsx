import { useEffect, useMemo, useState } from "react";
import {
  useAddPlannedMutation,
  useDeletePlannedMutation,
  useUpdatePlannedMutation,
  useDismissPlannedCandidateMutation,
  useDetectPlannedQuery,
  useAiDetectPlannedMutation,
  useGetCategoriesQuery,
  useGetPlannedQuery,
  useGetPlannedActualsQuery,
  useGetRatesQuery,
} from "../store/api.ts";
import { Money } from "../components/Money.tsx";
import { MerchantLogo } from "../components/MerchantLogo.tsx";
import { SubsCalendar } from "../components/SubsCalendar.tsx";
import { toast } from "../lib/toast.ts";
import { Select } from "../components/Select.tsx";
import { toUAHMinor, formatMinor } from "../lib/format.ts";
import type { PlannedPayment } from "../../shared/types.ts";

const fmtDate = new Intl.DateTimeFormat("uk-UA", { day: "numeric", month: "short" });
const CUR_OPTS = [
  { value: 980, label: "₴ UAH" },
  { value: 840, label: "$ USD" },
  { value: 978, label: "€ EUR" },
];

// Розстрочка завершена, коли пройшов її end_date — далі не списується.
function isFinished(p: PlannedPayment): boolean {
  return p.kind === "installment" && p.end_date != null && p.end_date <= Math.floor(Date.now() / 1000);
}

const pcount = (p: PlannedPayment) => Math.max(1, p.period_count ?? 1); // §SUB4 «кожні N»

// Скільки платежів розстрочки ще лишилось (від elapsed-періодів).
function remainingOccurrences(p: PlannedPayment): number | null {
  if (p.kind !== "installment" || p.occurrences == null) return null;
  const now = Math.floor(Date.now() / 1000);
  const step = (p.period === "week" ? 7 * 86400 : 30 * 86400) * pcount(p);
  const elapsed = Math.max(0, Math.floor((now - p.start_date) / step));
  return Math.max(0, p.occurrences - elapsed);
}

// Наступне списання: від start_date крокуємо періодом (× period_count) до майбутнього.
function nextCharge(p: PlannedPayment): number {
  const now = Math.floor(Date.now() / 1000);
  const n = pcount(p);
  if (p.period === "week") {
    let t = p.start_date;
    while (t <= now) t += 7 * 86400 * n;
    return t;
  }
  const d = new Date(p.start_date * 1000);
  while (d.getTime() / 1000 <= now) d.setMonth(d.getMonth() + n);
  return Math.floor(d.getTime() / 1000);
}

// Мітка каденції: «/міс», «/тиж», або «кожні N міс/тиж».
function cadenceLabel(p: PlannedPayment): string {
  const n = pcount(p);
  const unit = p.period === "week" ? "тиж" : "міс";
  return n === 1 ? `/${unit}` : `кожні ${n} ${unit}`;
}

// Місячний еквівалент (тижневі × 4.33; ділимо на period_count). Завершені не тягнуть.
function monthly(p: PlannedPayment): number {
  if (isFinished(p)) return 0;
  const per = (p.period_amount ?? 0) / pcount(p);
  return p.period === "week" ? per * 4.33 : per;
}

// §G1: з середнього інтервалу днів між списаннями виводимо period + «кожні N».
// Раніше при додаванні хардкодився «month», тож каденція й наступна дата були неправильні.
function cadenceFromDays(days: number): { period: "month" | "week"; period_count: number } {
  if (!days || days <= 0) return { period: "month", period_count: 1 };
  if (days <= 10) return { period: "week", period_count: 1 };   // щотижнева
  if (days <= 18) return { period: "week", period_count: 2 };   // раз на 2 тижні
  if (days <= 45) return { period: "month", period_count: 1 };  // щомісячна
  if (days <= 75) return { period: "month", period_count: 2 };  // раз на 2 міс
  return { period: "month", period_count: 3 };                  // квартальна
}

// §G1: додати підписку з кандидата — реальна дата останнього списання як старт (щоб
// «наступне» рахувалось коректно, а не сьогодні), каденція з інтервалу, звʼязок з категорією.
function plannedFromCandidate(
  c: { title: string; period_amount: number; currency_code?: number; avg_interval_days: number; last_time?: number; category_id?: number | null },
) {
  const cad = cadenceFromDays(c.avg_interval_days);
  return {
    title: c.title, kind: "subscription" as const,
    period: cad.period, period_count: cad.period_count,
    start_date: c.last_time ?? Math.floor(Date.now() / 1000),
    period_amount: c.period_amount, currency_code: c.currency_code ?? 980,
    category_id: c.category_id ?? null,
  };
}

export function Subscriptions() {
  const { data: planned } = useGetPlannedQuery();
  const { data: actuals } = useGetPlannedActualsQuery();
  const { data: cats } = useGetCategoriesQuery();
  const { data: ratesData } = useGetRatesQuery();
  // §Хвіст: факт vs план по кожній підписці (фактичні списання, останнє, подорожчання).
  const actualBy = useMemo(() => new Map((actuals ?? []).map((a) => [a.id, a])), [actuals]);
  const [deletePlanned] = useDeletePlannedMutation();
  const [updatePlanned] = useUpdatePlannedMutation();
  const rates = ratesData?.rates ?? {};

  const catName = useMemo(() => new Map((cats ?? []).map((c) => [c.id, c.name])), [cats]);
  // Опції категорій: батько → відступлені підкатегорії (для селектора на картці).
  const catOptions = useMemo(() => {
    const listc = cats ?? [];
    const out: { value: number; label: string; color?: string | null; icon?: string | null; indent?: boolean }[] = [];
    for (const p of listc.filter((c) => c.parent_id == null)) {
      out.push({ value: p.id, label: p.name + (p.is_income ? " (дохід)" : ""), color: p.color, icon: p.icon });
      for (const ch of listc.filter((c) => c.parent_id === p.id)) out.push({ value: ch.id, label: ch.name, color: ch.color ?? p.color, icon: ch.icon, indent: true });
    }
    return out;
  }, [cats]);
  const list = (planned ?? []).slice().sort((a, b) => nextCharge(a) - nextCharge(b));
  // Місячний тягар — зводимо кожну підписку в ₴ за її валютою (§F4).
  const burden = Math.round(list.reduce((s, p) => s + (toUAHMinor(monthly(p), p.currency_code ?? 980, rates) ?? monthly(p)), 0));

  return (
    <>
      <div className="page-head">
        <div>
          <div className="greet">Підписки</div>
          <div className="sub">Регулярні платежі, розстрочки й що скоро спишеться.</div>
        </div>
      </div>

      <div className="stack" style={{ gap: 18 }}>
        <div className="card sub-hero">
          <div>
            <div className="label">на місяць виходить</div>
            <div className="num-hero"><Money minor={burden} decimals={false} /></div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="label">активних</div>
            <div className="num-hero" style={{ fontSize: 30 }}>{list.length}</div>
          </div>
        </div>

        {list.length > 0 && (
          <div className="sub-grid">
            {list.map((p) => {
              const finished = isFinished(p);
              const rem = remainingOccurrences(p);
              return (
                <div key={p.id} className={`sub-card ${finished ? "is-finished" : ""}`}>
                  <button className="sub-card-x" onClick={() => deletePlanned(p.id)} aria-label="Видалити">✕</button>
                  <div className="sub-card-top">
                    <MerchantLogo merchant={p.title} color="var(--c-plum)" fallbackLabel={p.title} />
                    <div style={{ minWidth: 0 }}>
                      <div className="sub-card-name">{p.title}</div>
                      <div className="sub-card-kind">
                        {p.kind === "installment" ? "розстрочка" : "підписка"}
                        {p.category_id ? ` · ${catName.get(p.category_id) ?? ""}` : ""}
                      </div>
                    </div>
                  </div>
                  <div className="sub-card-amt">
                    <Money minor={p.period_amount ?? 0} currency={p.currency_code ?? 980} decimals={false} />
                    <span className="sub-card-per">{cadenceLabel(p)}</span>
                  </div>
                  {(p.currency_code ?? 980) !== 980 && (() => {
                    const uah = toUAHMinor(p.period_amount ?? 0, p.currency_code ?? 980, rates);
                    return uah != null ? <div className="sub-card-fx">≈ {formatMinor(uah, { decimals: false })} ₴ {cadenceLabel(p)}</div> : null;
                  })()}
                  {(() => {
                    // §Хвіст: факт vs план — скільки реально списувалось + ознака подорожчання.
                    const a = actualBy.get(p.id);
                    if (!a || a.count === 0) return null;
                    const up = a.price_change_pct != null && a.price_change_pct >= 5;
                    const down = a.price_change_pct != null && a.price_change_pct <= -5;
                    return (
                      <div className="sub-card-fx" style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                        <span>факт: {a.count}× списань</span>
                        {a.last_amount != null && (
                          <span>· останнє <Money minor={a.last_amount} currency={a.currency_code ?? p.currency_code ?? 980} decimals={false} /></span>
                        )}
                        {up && <span className="sub-badge" style={{ background: "var(--c-rose, #e5484d)", color: "#fff" }}>↑ подорожчало {a.price_change_pct}%</span>}
                        {down && <span className="sub-badge">↓ {Math.abs(a.price_change_pct as number)}% дешевше</span>}
                      </div>
                    );
                  })()}
                  <div className="sub-card-foot">
                    {finished ? (
                      <span className="sub-badge done">завершено</span>
                    ) : (
                      <>
                        <span className="sub-badge">наступне {fmtDate.format(nextCharge(p) * 1000)}</span>
                        {rem != null && <span className="sub-rem">лишилось ~{rem}</span>}
                      </>
                    )}
                  </div>
                  <div className="sub-card-cat">
                    <span className="label" style={{ fontSize: 10.5 }}>категорія</span>
                    <Select value={p.category_id} options={catOptions} searchable clearable clearLabel="— без категорії"
                      placeholder="— обрати категорію"
                      onChange={(v) => updatePlanned({ id: p.id, category_id: v == null ? null : Number(v) })} />
                  </div>
                  <SubNote id={p.id} note={p.note ?? ""} onSave={(note) => updatePlanned({ id: p.id, note })} />
                </div>
              );
            })}
          </div>
        )}

        <SubsCalendar />

        <AiDetect />
        <Detected />
        <AddForm />
      </div>
    </>
  );
}

// AI-детект за описом (§F4): опиши підписку словами → AI знайде схожі транзакції.
function AiDetect() {
  const [detect, { isLoading }] = useAiDetectPlannedMutation();
  const [addPlanned] = useAddPlannedMutation();
  const { data: cats } = useGetCategoriesQuery();
  const catName = useMemo(() => new Map((cats ?? []).map((c) => [c.id, c.name])), [cats]);
  const [desc, setDesc] = useState("");
  const [cands, setCands] = useState<{ title: string; period_amount: number; currency_code: number; n: number; avg_interval_days: number; last_time?: number; category_id?: number | null }[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function run() {
    setMsg(null); setCands(null);
    try {
      const r = await detect(desc.trim()).unwrap();
      if (r.error) { setMsg(r.error.includes("not set") ? "AI-ключ не налаштовано (перевір на проді)." : r.error); return; }
      setCands(r.candidates);
      if (!r.candidates.length) setMsg("Схожих транзакцій не знайшов. Спробуй інший опис.");
    } catch { setMsg("Не вдалося. Спробуй ще раз."); }
  }

  return (
    <section>
      <div className="section-head">
        <h2>✨ Знайти підписку через AI</h2>
        <span className="label">опиши словами — знайду в історії</span>
      </div>
      <div className="card sub-ai-block">
        <p className="sub-ai-hint">
          AI прочитає твій опис, знайде схожі регулярні списання в транзакціях і порахує суму та каденцію —
          лишиться натиснути «додати».
        </p>
        <div className="row" style={{ gap: 8 }}>
          <input placeholder="напр. «моя підписка на Anthropic» чи «інтернет Київстар»"
            value={desc} onChange={(e) => setDesc(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && desc.trim() && run()} />
          <button className="btn primary" style={{ whiteSpace: "nowrap" }} onClick={run} disabled={isLoading || !desc.trim()}>
            {isLoading ? "Шукаю…" : "Знайти"}
          </button>
        </div>
        {msg && <div className="muted" style={{ fontSize: 13, marginTop: 10 }}>{msg}</div>}
        {cands && cands.length > 0 && (
          <div className="sub-cands">
            {cands.map((c, i) => (
              <div key={i} className="sub-row">
                <MerchantLogo merchant={c.title} color="var(--accent)" fallbackLabel={c.title} />
                <div className="s-body">
                  <div className="s-name">{c.title}</div>
                  <div className="s-meta">
                    {c.n}× · кожні ~{c.avg_interval_days} дн
                    {c.category_id != null && catName.get(c.category_id) ? ` · ${catName.get(c.category_id)}` : ""}
                  </div>
                </div>
                <div className="s-amt"><Money minor={c.period_amount} currency={c.currency_code} decimals={false} /></div>
                <button className="btn primary" style={{ padding: "6px 10px" }}
                  onClick={() => addPlanned(plannedFromCandidate(c))}>+ додати</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

// Редаговане поле «опис для AI» на картці підписки. Зберігає на blur, якщо змінилось.
function SubNote({ id, note, onSave }: { id: number; note: string; onSave: (note: string) => void }) {
  const [val, setVal] = useState(note);
  // Синхронізуємо, якщо note оновився ззовні (напр. після рефетчу).
  useEffect(() => setVal(note), [note, id]);
  return (
    <textarea
      className="sub-note"
      rows={2}
      value={val}
      placeholder="опис для AI: що це за платіж (напр. «сімейний Apple, це не розваги»)"
      onChange={(e) => setVal(e.target.value)}
      onBlur={() => { if (val.trim() !== note.trim()) onSave(val.trim()); }}
    />
  );
}

function Detected() {
  const { data: candidates } = useDetectPlannedQuery();
  const { data: cats } = useGetCategoriesQuery();
  const [addPlanned, { isLoading }] = useAddPlannedMutation();
  const [dismiss] = useDismissPlannedCandidateMutation();
  const catName = useMemo(() => new Map((cats ?? []).map((c) => [c.id, c.name])), [cats]);
  if (!candidates?.length) return null;
  return (
    <section>
      <div className="section-head"><h2>Схоже на підписки</h2><span className="label">знайдено автоматично</span></div>
      <div className="sub-detected">
        {candidates.map((c) => {
          const cad = cadenceFromDays(c.avg_interval_days);
          return (
            <div key={`${c.merchant}-${c.amount}`} className="sub-row card">
              <MerchantLogo merchant={c.merchant} color="var(--c-teal)" fallbackLabel={c.merchant} />
              <div className="s-body">
                <div className="s-name">{c.merchant}</div>
                <div className="s-meta">
                  {c.n}× · {cad.period_count === 1 ? (cad.period === "week" ? "щотижня" : "щомісяця") : `кожні ${cad.period_count} ${cad.period === "week" ? "тиж" : "міс"}`}
                  {c.category_id != null && catName.get(c.category_id) ? ` · ${catName.get(c.category_id)}` : ""}
                </div>
              </div>
              <div className="s-amt"><Money minor={c.amount} currency={c.currency_code ?? 980} decimals={false} /></div>
              <button className="btn primary" style={{ padding: "6px 10px" }} disabled={isLoading}
                onClick={() => addPlanned(plannedFromCandidate({
                  title: c.merchant, period_amount: c.amount, currency_code: c.currency_code,
                  avg_interval_days: c.avg_interval_days, last_time: c.last_time, category_id: c.category_id,
                }))}>+ додати</button>
              <button className="btn ghost s-dismiss" title="Це не підписка — сховати"
                onClick={() => dismiss(c.merchant)} aria-label="Це не підписка">✕</button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function AddForm() {
  const [addPlanned, { isLoading: adding }] = useAddPlannedMutation();
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<"subscription" | "installment">("subscription");
  const [period, setPeriod] = useState<"month" | "week">("month");
  const [periodCount, setPeriodCount] = useState("1");
  const [currency, setCurrency] = useState(980);
  const [periodAmount, setPeriodAmount] = useState("");
  const [totalAmount, setTotalAmount] = useState("");

  async function submit() {
    const perMinor = Math.round(Number(periodAmount || 0) * 100);
    const totMinor = Math.round(Number(totalAmount || 0) * 100);
    if (!title.trim()) { toast.error("Вкажи назву"); return; }
    if (kind === "subscription" && !perMinor) { toast.error("Вкажи суму за період"); return; }
    if (kind === "installment" && (!totMinor || !perMinor)) { toast.error("Для розстрочки потрібні повна сума і платіж"); return; }
    try {
      await addPlanned({
        title: title.trim(), kind, period, period_count: Math.max(1, Math.round(Number(periodCount) || 1)),
        currency_code: currency,
        start_date: Math.floor(Date.now() / 1000),
        period_amount: perMinor || null,
        total_amount: kind === "installment" ? totMinor : null,
      }).unwrap();
      setTitle(""); setPeriodAmount(""); setTotalAmount(""); setPeriodCount("1");
      toast.success("Додано");
    } catch (e) { toast.error(String(e)); }
  }

  return (
    <section>
      <div className="section-head"><h2>Додати вручну</h2></div>
      <div className="card" style={{ padding: 18 }}>
        <div className="stack">
          <div className="row" style={{ gap: 8 }}>
            <Select value={kind} onChange={(v) => setKind(v as typeof kind)}
              options={[{ value: "subscription", label: "Підписка" }, { value: "installment", label: "Розстрочка" }]} />
            <Select value={period} onChange={(v) => setPeriod(v as typeof period)}
              options={[{ value: "month", label: "на місяць" }, { value: "week", label: "на тиждень" }]} />
            <Select value={currency} onChange={(v) => setCurrency(Number(v))} options={CUR_OPTS} />
          </div>
          <label className="row sub-every">
            <span className="label" style={{ whiteSpace: "nowrap" }}>кожні</span>
            <input type="number" min={1} inputMode="numeric" value={periodCount}
              onChange={(e) => setPeriodCount(e.target.value)} style={{ width: 72 }} />
            <span className="muted" style={{ fontSize: 13 }}>{period === "week" ? "тиж." : "міс."} (1 = щоразу; 3 = раз на квартал)</span>
          </label>
          <input placeholder="Назва (напр. Netflix)" value={title} onChange={(e) => setTitle(e.target.value)} />
          <input type="number" inputMode="decimal"
            placeholder={kind === "installment" ? "Сума платежу за період" : "Сума за період"}
            value={periodAmount} onChange={(e) => setPeriodAmount(e.target.value)} />
          {kind === "installment" && (
            <input type="number" inputMode="decimal" placeholder="Повна сума розстрочки"
              value={totalAmount} onChange={(e) => setTotalAmount(e.target.value)} />
          )}
          {kind === "installment" && Number(totalAmount) > 0 && Number(periodAmount) > 0 && (
            <p className="muted" style={{ fontSize: 12, margin: 0 }}>
              ≈ {Math.ceil(Number(totalAmount) / Number(periodAmount))} платежів
            </p>
          )}
          <button className="btn primary" onClick={submit} disabled={adding}>Додати</button>
        </div>
      </div>
    </section>
  );
}
