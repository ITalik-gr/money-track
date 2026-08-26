import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getLocale, dateFmt } from "../i18n/locale.ts";
import { useT, translate } from "../i18n/index.ts";
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
import type { AiDetectResult } from "../../shared/api/index.ts";
import { Money } from "../components/ui/Money.tsx";
import { MerchantLogo } from "../components/ui/MerchantLogo.tsx";
import { Icon } from "../components/ui/Icon.tsx";
import { CashflowCalendar } from "../components/stats/CashflowCalendar.tsx";
import { toast } from "../lib/toast.ts";
import { errText } from "../lib/errors.ts";
import { Select } from "../components/ui/Select.tsx";
import { SubGridSkeleton } from "../components/ui/Skeleton.tsx";
import { toBaseMinor, formatMinor } from "../lib/format.ts";
import type { PlannedPayment } from "../../shared/types.ts";
import { baseSign, getBaseCurrency } from "../lib/currency.ts";
import { ErrorNote } from "../components/ui/ErrorNote.tsx";

const fmtDate = dateFmt({ day: "numeric", month: "short" });
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
  const loc = getLocale();
  const unit = translate(loc, p.period === "week" ? "sub.unitWeek" : "sub.unitMonth");
  return n === 1 ? `/${unit}` : translate(loc, "sub.everyN", { n, unit });
}

// Місячний еквівалент (ділимо на period_count; тижневі × середню кількість тижнів у місяці).
// The weekly→monthly multiplier that used to live here is GONE, and so is the comment promising
// it matched the server's. A note asserting that two copies agree is the tell, not the safeguard
// (§SIMILAR made the same observation about `coreToken`): the multiplier did match, and the
// end-of-plan rule beside it did not.
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
  const t = useT();
  const { data: planned, isLoading: loadingPlanned, error: plannedError, refetch: refetchPlanned } = useGetPlannedQuery();
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
      out.push({ value: p.id, label: p.name + (p.is_income ? t("tx.categoryIncomeSuffix") : ""), color: p.color, icon: p.icon });
      for (const ch of listc.filter((c) => c.parent_id === p.id)) out.push({ value: ch.id, label: ch.name, color: ch.color ?? p.color, icon: ch.icon, indent: true });
    }
    return out;
  }, [cats, t]);
  /**
   * §INCOME-PLAN: this page is about money going OUT, so income plans are filtered here.
   *
   * `GET /planned` deliberately returns everything (it is the plans table, and the income rows have
   * to reach the form that manages them), so the exclusion belongs to the reader that means
   * "subscriptions". Without it a salary would be listed as a subscription AND added to the monthly
   * burden — a number the advisor, the dashboard and the Telegram push all quote.
   */
  const list = (planned ?? []).filter((p) => p.kind !== "income")
    .slice().sort((a, b) => nextCharge(a) - nextCharge(b));
  const incomePlans = (planned ?? []).filter((p) => p.kind === "income");
  /**
   * §SUB-MONTH: the monthly burden comes from the SERVER (`monthly_base` on each plan).
   *
   * This page had its own `monthly()` — the very page whose disagreement with the rest of the app
   * bought the rule in the first place. Its arithmetic still matched; its "is this plan over"
   * test no longer did (`isFinished` covers `installment` only, the canon ends anything past its
   * `end_date`), so a cancelled subscription with an end date was counted here and nowhere else.
   * It also converted through `toBaseMinor(...) ?? monthly(p)`, where the fallback is unreachable
   * and an unknown currency therefore silently weighed ZERO.
   */
  const burden = list.reduce((s, p) => s + p.monthly_base, 0);
  const topExpensive = list
    .map((p) => ({ p, uah: p.monthly_base }))
    .filter((x) => x.uah > 0)
    .sort((a, b) => b.uah - a.uah)
    .slice(0, 3);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="greet">{t("sub.title")}</div>
          <div className="sub">{t("sub.sub")}</div>
        </div>
      </div>

      <div className="stack" style={{ gap: 18 }}>
        <div className="card sub-hero">
          <div>
            <div className="label">{t("sub.perMonth")}</div>
            <div className="num-hero"><Money minor={burden} decimals={false} /></div>
            <div className="sub-hero-year">{t("sub.perYear", { amount: formatMinor(burden * 12, { decimals: false }) })}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="label">{t("sub.active")}</div>
            <div className="num-hero" style={{ fontSize: 30 }}>{list.length}</div>
          </div>
        </div>

        {/*
          §INCOME-PLAN — expected inflows get their OWN section, above the subscriptions.
          They live in the same table and are created by the same form, but mixing them into the
          grid would put a salary inside "what you pay every month". Kept on this page rather than
          given a new one: this is where a recurring amount on a schedule is managed, and a second
          screen for the same table is how two ways to edit one thing appear.
        */}
        {incomePlans.length > 0 && (
          <section>
            <div className="section-head">
              <h2>{t("sub.incomeTitle")}</h2>
              <span className="label">{t("sub.incomeSectionHint")}</span>
            </div>
            <div className="inc-list">
              {incomePlans.map((p) => (
                <div className="card inc-row" key={p.id}>
                  <span className="inc-name">{p.title}</span>
                  <span className="inc-amt">
                    {p.amount_varies ? "≈" : ""}
                    <Money minor={p.period_amount ?? 0} decimals={false} />
                    <span className="inc-per"> / {t(p.period === "week" ? "sub.unitWeek" : "sub.unitMonth")}</span>
                  </span>
                  <button className="sub-card-x" onClick={() => deletePlanned(p.id)} aria-label={t("common.delete")}>✕</button>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Порожня сітка й «ще не завантажилось» виглядають однаково — а це різні речі. */}
        {loadingPlanned && <SubGridSkeleton />}

        {list.length > 0 && (
          <div className="sub-grid">
            {list.map((p) => {
              const finished = isFinished(p);
              const rem = remainingOccurrences(p);
              return (
                <div key={p.id} className={`sub-card ${finished ? "is-finished" : ""}`}>
                  <button className="sub-card-x" onClick={() => deletePlanned(p.id)} aria-label={t("common.delete")}>✕</button>
                  <div className="sub-card-top">
                    <MerchantLogo merchant={p.title} color="var(--c-plum)" fallbackLabel={p.title} />
                    <div style={{ minWidth: 0 }}>
                      {/* §SUB-PAGE: the name is the way in. A card that shows four figures and
                          cannot be opened is where every "why is this so expensive" question dies. */}
                      <Link className="sub-card-name" to={`/subs/${p.id}`}>{p.title}</Link>
                      <div className="sub-card-kind">
                        {p.kind === "installment" ? t("sub.kindInstallment")
                          : p.kind === "income" ? t("sub.kindIncome") : t("sub.kindSubscription")}
                        {p.category_id ? ` · ${catName.get(p.category_id) ?? ""}` : ""}
                      </div>
                    </div>
                  </div>
                  <div className="sub-card-amt">
                    <Money minor={p.period_amount ?? 0} currency={p.currency_code ?? 980} decimals={false} />
                    <span className="sub-card-per">{cadenceLabel(p)}</span>
                  </div>
                  {/* §BASE-CUR: the equivalent line appears whenever the plan's currency differs
                      from the one this screen totals in — which is no longer "not hryvnia". */}
                  {(p.currency_code ?? 980) !== getBaseCurrency() && (() => {
                    const uah = toBaseMinor(p.period_amount ?? 0, p.currency_code ?? 980, rates);
                    return uah != null ? <div className="sub-card-fx">≈ {formatMinor(uah, { decimals: false })} {baseSign()} {cadenceLabel(p)}</div> : null;
                  })()}
                  {(() => {
                    // §Хвіст: факт vs план — скільки реально списувалось + ознака подорожчання.
                    const a = actualBy.get(p.id);
                    if (!a || a.count === 0) return null;
                    const up = a.price_change_pct != null && a.price_change_pct >= 5;
                    const down = a.price_change_pct != null && a.price_change_pct <= -5;
                    // Абсолютна дельта в грошах + вплив на рік — «+50 ₴ (600 ₴/рік)» переконує
                    // сильніше за голий відсоток. Рік = дельта × кількість списань на рік.
                    const cur = a.currency_code ?? p.currency_code ?? 980;
                    const delta = a.last_amount != null ? a.last_amount - (p.period_amount ?? 0) : null;
                    const perYear = delta != null ? Math.round(delta * (p.period === "week" ? 52 : 12) / pcount(p)) : null;
                    return (
                      <div className="sub-card-fx sub-fact">
                        <span>{t("sub.factCount", { count: a.count })}</span>
                        {a.last_amount != null && (
                          <span>{t("sub.lastAmount")} <Money minor={a.last_amount} currency={cur} decimals={false} /></span>
                        )}
                        {up && delta != null && (
                          <span className="sub-badge up" title={t("sub.priceUpTitle", { plan: Math.round((p.period_amount ?? 0) / 100), fact: Math.round(a.last_amount! / 100) })}>
                            ↑ +<Money minor={delta} currency={cur} decimals={false} />
                            {perYear != null && <span className="sub-badge-sub"> · +<Money minor={perYear} currency={cur} decimals={false} />{t("sub.perYearShort")}</span>}
                          </span>
                        )}
                        {down && delta != null && (
                          <span className="sub-badge down">
                            ↓ <Money minor={Math.abs(delta)} currency={cur} decimals={false} /> {t("sub.cheaper")}
                          </span>
                        )}
                      </div>
                    );
                  })()}
                  <div className="sub-card-foot">
                    {finished ? (
                      <span className="sub-badge done">{t("sub.finished")}</span>
                    ) : (
                      <>
                        <span className="sub-badge">{t("sub.next")} {fmtDate.format(nextCharge(p) * 1000)}</span>
                        {rem != null && <span className="sub-rem">{t("sub.remaining", { n: rem })}</span>}
                        {(() => {
                          // Детект «мертвої»: активна >60 днів, але поряд НЕ видно фактичних списань → лише підказка.
                          const a = actualBy.get(p.id);
                          const ageDays = (Date.now() / 1000 - p.start_date) / 86400;
                          const stale = (!a || a.count === 0) && ageDays > 60;
                          return stale ? <span className="sub-badge dead" title={t("sub.deadTitle")}>{t("sub.deadBadge")}</span> : null;
                        })()}
                      </>
                    )}
                  </div>
                  <div className="sub-card-cat">
                    <span className="label" style={{ fontSize: 10.5 }}>{t("sub.category")}</span>
                    <Select value={p.category_id} options={catOptions} searchable clearable clearLabel={t("sub.noCategory")}
                      placeholder={t("sub.pickCategory")}
                      onChange={(v) => updatePlanned({ id: p.id, category_id: v == null ? null : Number(v) })} />
                  </div>
                  <SubNote id={p.id} note={p.note ?? ""} onSave={(note) => updatePlanned({ id: p.id, note })} />
                </div>
              );
            })}
          </div>
        )}

        {list.length === 0 && (
          plannedError ? (
            // The empty text offers to let the AI find subscriptions in your history — an offer
            // that makes no sense to someone who already has a dozen and simply lost the request.
            <ErrorNote error={plannedError} what={t("nav.subs")} onRetry={refetchPlanned} />
          ) : <div className="card empty" style={{ padding: 28 }}>
            {t("sub.empty")}
          </div>
        )}

        {topExpensive.length >= 3 && (
          <div className="card top-subs-card">
            <div className="section-head"><h2>{t("sub.expensive")}</h2><span className="label">{t("sub.perMonthShort")}</span></div>
            <div className="top-subs">
              {topExpensive.map(({ p, uah }) => (
                <div className="top-sub-row" key={p.id}>
                  <MerchantLogo merchant={p.title} color="var(--c-plum)" fallbackLabel={p.title} />
                  <span className="top-sub-name">{p.title}</span>
                  <span className="top-sub-amt">{t("sub.uahPerMonth", { amount: formatMinor(uah, { decimals: false }) })}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <CashflowCalendar />

        {/*
          Two ways to add one thing, so they stand SIDE BY SIDE (2026-08-14, owner: "these two
          blocks are very wide and no longer match the design"). Each was a full-width band, which
          made "describe it and let AI find it" and "type it in" read as two unrelated stages of a
          wizard rather than as a choice between two doors to the same room.
        */}
        <Detected />
        <div className="sub-add-pair">
          <AiDetect />
          <AddForm />
        </div>
      </div>
    </>
  );
}

// AI-детект за описом (§F4): опиши підписку словами → AI знайде схожі транзакції.
function AiDetect() {
  const t = useT();
  const [detect, { isLoading }] = useAiDetectPlannedMutation();
  const [addPlanned] = useAddPlannedMutation();
  const { data: cats } = useGetCategoriesQuery();
  const catName = useMemo(() => new Map((cats ?? []).map((c) => [c.id, c.name])), [cats]);
  const [desc, setDesc] = useState("");
  const [cands, setCands] = useState<AiDetectResult["candidates"] | null>(null);
  // §SUB-FIND: WHAT was searched for, shown beside the results. A screenful of unrelated merchants
  // reads as a broken search until you can see it looked for «X» — then it reads as the wrong word,
  // which is a thing the person can fix.
  const [terms, setTerms] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  async function run() {
    setMsg(null); setCands(null); setTerms([]);
    try {
      const r = await detect(desc.trim()).unwrap();
      if (r.error) { setMsg(r.error.includes("not set") ? t("sub.aiKeyMissing") : r.error); return; }
      setCands(r.candidates);
      setTerms(r.terms ?? []);
      if (!r.candidates.length) setMsg(t("sub.aiNoMatch"));
    } catch { setMsg(t("sub.aiFailed")); }
  }

  return (
    <section>
      <div className="section-head">
        <h2 className="h-ico"><Icon name="spark" size={16} />{t("sub.aiFindTitle")}</h2>
        <span className="label">{t("sub.aiFindSub")}</span>
      </div>
      <div className="card sub-ai-block">
        <p className="sub-ai-hint">
          {t("sub.aiHint")}
        </p>
        <div className="row" style={{ gap: 8 }}>
          <input placeholder={t("sub.aiPlaceholder")}
            value={desc} onChange={(e) => setDesc(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && desc.trim() && run()} />
          <button className="btn primary" style={{ whiteSpace: "nowrap" }} onClick={run} disabled={isLoading || !desc.trim()}>
            {isLoading ? t("sub.aiSearching") : t("sub.aiSearch")}
          </button>
        </div>
        {terms.length > 0 && (
          <div className="sub-ai-terms">{t("sub.aiTerms")} {terms.map((x) => <span key={x} className="chip sm">{x}</span>)}</div>
        )}
        {msg && <div className="muted" style={{ fontSize: 13, marginTop: 10 }}>{msg}</div>}
        {cands && cands.length > 0 && (
          <div className="sub-cands">
            {cands.map((c, i) => (
              <div key={i} className="sub-row">
                <MerchantLogo merchant={c.title} color="var(--accent)" fallbackLabel={c.title} />
                <div className="s-body">
                  <div className="s-name">{c.title}</div>
                  <div className="s-meta">
                    {t("sub.candMeta", { n: c.n, days: c.avg_interval_days })}
                    {c.category_id != null && catName.get(c.category_id) ? ` · ${catName.get(c.category_id)}` : ""}
                  </div>
                </div>
                <div className="s-amt"><Money minor={c.period_amount} currency={c.currency_code} decimals={false} /></div>
                <button className="btn primary sm"
                  onClick={() => addPlanned(plannedFromCandidate(c))}>{t("sub.add")}</button>
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
  const t = useT();
  const [val, setVal] = useState(note);
  // Синхронізуємо, якщо note оновився ззовні (напр. після рефетчу).
  useEffect(() => setVal(note), [note, id]);
  return (
    <textarea
      className="sub-note"
      rows={2}
      value={val}
      placeholder={t("sub.notePlaceholder")}
      onChange={(e) => setVal(e.target.value)}
      onBlur={() => { if (val.trim() !== note.trim()) onSave(val.trim()); }}
    />
  );
}

function Detected() {
  const t = useT();
  const { data: candidates } = useDetectPlannedQuery();
  const { data: cats } = useGetCategoriesQuery();
  const [addPlanned, { isLoading }] = useAddPlannedMutation();
  const [dismiss] = useDismissPlannedCandidateMutation();
  const catName = useMemo(() => new Map((cats ?? []).map((c) => [c.id, c.name])), [cats]);
  if (!candidates?.length) return null;
  return (
    <section>
      <div className="section-head"><h2>{t("sub.detectedTitle")}</h2><span className="label">{t("sub.detectedSub")}</span></div>
      <div className="sub-detected">
        {candidates.map((c) => {
          const cad = cadenceFromDays(c.avg_interval_days);
          return (
            <div key={`${c.merchant}-${c.amount}`} className="sub-row card">
              <MerchantLogo merchant={c.merchant} color="var(--c-teal)" fallbackLabel={c.merchant} />
              <div className="s-body">
                <div className="s-name">{c.merchant}</div>
                <div className="s-meta">
                  {c.n}× · {cad.period_count === 1
                    ? t(cad.period === "week" ? "sub.weekly" : "sub.monthly")
                    : t("sub.everyN", { n: cad.period_count, unit: t(cad.period === "week" ? "sub.unitWeek" : "sub.unitMonth") })}
                  {c.category_id != null && catName.get(c.category_id) ? ` · ${catName.get(c.category_id)}` : ""}
                </div>
              </div>
              <div className="s-amt"><Money minor={c.amount} currency={c.currency_code ?? 980} decimals={false} /></div>
              <button className="btn primary sm" disabled={isLoading}
                onClick={() => addPlanned(plannedFromCandidate({
                  title: c.merchant, period_amount: c.amount, currency_code: c.currency_code,
                  avg_interval_days: c.avg_interval_days, last_time: c.last_time, category_id: c.category_id,
                }))}>{t("sub.add")}</button>
              <button className="btn ghost s-dismiss" title={t("sub.dismissTitle")}
                onClick={() => dismiss(c.merchant)} aria-label={t("sub.dismissAria")}>✕</button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function AddForm() {
  const t = useT();
  const [addPlanned, { isLoading: adding }] = useAddPlannedMutation();
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<"subscription" | "installment" | "income">("subscription");
  // §INCOME-PLAN: the owner's constraint, made explicit — income in life is neither the same size
  // nor on time. The flag does not change the schedule, it only stops the app quoting an estimate
  // as though it were a promise.
  const [varies, setVaries] = useState(true);
  const [period, setPeriod] = useState<"month" | "week">("month");
  const [periodCount, setPeriodCount] = useState("1");
  const [currency, setCurrency] = useState(980);
  const [periodAmount, setPeriodAmount] = useState("");
  const [totalAmount, setTotalAmount] = useState("");

  async function submit() {
    const perMinor = Math.round(Number(periodAmount || 0) * 100);
    const totMinor = Math.round(Number(totalAmount || 0) * 100);
    if (!title.trim()) { toast.error(t("sub.nameRequired")); return; }
    if ((kind === "subscription" || kind === "income") && !perMinor) { toast.error(t("sub.amountRequired")); return; }
    if (kind === "installment" && (!totMinor || !perMinor)) { toast.error(t("sub.installmentRequired")); return; }
    try {
      await addPlanned({
        title: title.trim(), kind, period, period_count: Math.max(1, Math.round(Number(periodCount) || 1)),
        currency_code: currency,
        start_date: Math.floor(Date.now() / 1000),
        period_amount: perMinor || null,
        total_amount: kind === "installment" ? totMinor : null,
        amount_varies: kind === "income" ? varies : false,
      }).unwrap();
      setTitle(""); setPeriodAmount(""); setTotalAmount(""); setPeriodCount("1");
      toast.success(t("sub.added"));
    } catch (e) { toast.error(errText(e)); }
  }

  return (
    <section>
      <div className="section-head"><h2>{t("sub.addManual")}</h2></div>
      <div className="card" style={{ padding: 18 }}>
        <div className="stack">
          <div className="row" style={{ gap: 8 }}>
            <Select value={kind} onChange={(v) => setKind(v as typeof kind)}
              options={[
                { value: "subscription", label: t("sub.typeSubscription") },
                { value: "installment", label: t("sub.typeInstallment") },
                { value: "income", label: t("sub.typeIncome") },
              ]} />
            <Select value={period} onChange={(v) => setPeriod(v as typeof period)}
              options={[{ value: "month", label: t("sub.optMonth") }, { value: "week", label: t("sub.optWeek") }]} />
            <Select value={currency} onChange={(v) => setCurrency(Number(v))} options={CUR_OPTS} />
          </div>
          <label className="row sub-every">
            <span className="label" style={{ whiteSpace: "nowrap" }}>{t("sub.every")}</span>
            <input type="number" min={1} inputMode="numeric" value={periodCount}
              onChange={(e) => setPeriodCount(e.target.value)} style={{ width: 72 }} />
            <span className="muted" style={{ fontSize: 13 }}>{t("sub.everyHint", { unit: t(period === "week" ? "sub.unitWeek" : "sub.unitMonth") + "." })}</span>
          </label>
          <input placeholder={t("sub.namePlaceholder")} value={title} onChange={(e) => setTitle(e.target.value)} />
          <input type="number" inputMode="decimal"
            placeholder={kind === "installment" ? t("sub.amountPerPeriod") : t("sub.amountPerPeriodPlain")}
            value={periodAmount} onChange={(e) => setPeriodAmount(e.target.value)} />
          {kind === "installment" && (
            <input type="number" inputMode="decimal" placeholder={t("sub.totalAmount")}
              value={totalAmount} onChange={(e) => setTotalAmount(e.target.value)} />
          )}
          {kind === "income" && (
            <>
              <label className="row" style={{ gap: 8, alignItems: "center" }}>
                <input type="checkbox" checked={varies} onChange={(e) => setVaries(e.target.checked)} />
                <span style={{ fontSize: 13 }}>{t("sub.incomeVaries")}</span>
              </label>
              {/* Said at the moment of creation, because this is where the expectation is set:
                  the figure informs the FORECAST and never the "free to spend" number. */}
              <p className="muted" style={{ fontSize: 12, margin: 0 }}>{t("sub.incomeHint")}</p>
            </>
          )}
          {kind === "installment" && Number(totalAmount) > 0 && Number(periodAmount) > 0 && (
            <p className="muted" style={{ fontSize: 12, margin: 0 }}>
              {t("sub.paymentsCount", { n: Math.ceil(Number(totalAmount) / Number(periodAmount)) })}
            </p>
          )}
          <button className="btn primary" onClick={submit} disabled={adding}>{t("sub.addBtn")}</button>
        </div>
      </div>
    </section>
  );
}
