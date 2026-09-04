import { useState } from "react";
import { Y_AXIS, Y_AXIS_LEFT_MARGIN } from "../lib/chart.ts";
import { dateFmt } from "../i18n/locale.ts";
import { useT } from "../i18n/index.ts";
import { Link, useSearchParams } from "react-router-dom";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import {
  useGenerateAdviceMutation,
  useGetAdviceQuery,
  useGetAdviceHistoryQuery,
  useClearAdviceHistoryMutation,
  useDeleteAdviceHistoryEntryMutation,
  useSetBudgetMutation,
  useCreateGoalMutation,
  useDeletePlannedMutation,
  useCreateRuleMutation,
  useSetSuggestionStateMutation,
  useCreateJobMutation,
  useGetJobsQuery,
} from "../store/api.ts";
import type { AdviceAction, Advice, AdviceHistoryItem, AdviceSuggestion, SuggestionState } from "../store/api.ts";
import { Money } from "../components/ui/Money.tsx";
import { Gauge } from "../components/ui/Gauge.tsx";
import { AiInsightCard } from "../components/advisor/AiInsightCard.tsx";
import { WhatIf } from "../components/advisor/WhatIf.tsx";
import { RichFacts } from "../components/advisor/RichFacts.tsx";
import { FactsCard } from "../components/advisor/FactsCard.tsx";
import { HealthIndexCard } from "../components/stats/HealthIndexCard.tsx";
import { KnowledgeCorpusCard } from "../components/advisor/KnowledgeCorpusCard.tsx";
import { CashflowCalendar } from "../components/stats/CashflowCalendar.tsx";
import { SpendFloorCard } from "../components/advisor/SpendFloor.tsx";
import { NetworthCard } from "../components/stats/NetworthCard.tsx";
import { UsageCost } from "../components/settings/UsageCost.tsx";
import { InfoTip } from "../components/ui/InfoTip.tsx";
import { RunwaySkeleton, AdviceSkeleton } from "../components/ui/Skeleton.tsx";
import { Icon } from "../components/ui/Icon.tsx";
import { highlightAmounts } from "../lib/highlight.tsx";
import { renderRich } from "../lib/citations.tsx";
import { formatMinor } from "../lib/format.ts";
import { CHART_ANIM } from "../lib/motion.ts";
import { toast } from "../lib/toast.ts";
import { errText, errStatus } from "../lib/errors.ts";
import { baseSign, signFor } from "../lib/currency.ts";

// AI-порадник: числа (runway) + структуровані поради + інтерактивне «запитай/опиши».
// Профіль «про мене» редагується лише в Налаштуваннях — AI його й так знає в усіх викликах.
const TABS = { advice: "adv.tabAdvice", state: "adv.tabState" } as const;
type AdvTab = keyof typeof TABS;

export function Advisor() {
  const t = useT();
  const { data: stored, isLoading: loadingAdvice } = useGetAdviceQuery();
  const [generate] = useGenerateAdviceMutation();
  // §A6: генерація живе в черзі на сервері, тож «іде» — це стан ЗАДАЧІ, а не цієї сторінки.
  // Завдяки цьому спінер лишається правдивим, якщо піти й повернутись посеред прогону.
  const [createJob, { isLoading: queueing }] = useCreateJobMutation();
  const { data: jobs } = useGetJobsQuery();
  const generating = queueing || (jobs?.items ?? []).some(
    (j) => j.kind === "advisor" && (j.status === "queued" || j.status === "running"),
  );
  const [genError, setGenError] = useState<string | null>(null);
  // Детермінований fallback свідомо НЕ зберігається на сервері (щоб не затер останню
  // нормальну AI-пораду), тож тримаємо його тут і показуємо замість збереженої.
  const [fallback, setFallback] = useState<Advice | null>(null);
  const advice = fallback ?? stored;
  const [params, setParams] = useSearchParams();
  const tab: AdvTab = params.get("tab") === "state" ? "state" : "advice";
  const setTab = (t: AdvTab) => setParams((p) => { p.set("tab", t); return p; }, { replace: true });

  async function runAdvice() {
    setGenError(null);
    try {
      await createJob({ kind: "advisor" }).unwrap();
      setFallback(null);
      toast.info(t("jobs.started"));
    } catch (e) {
      // Без AI-ключа сервер відмовляє ЩЕ ДО черги (400). Це саме той випадок, заради якого
      // існує детермінований fallback: беремо його старим синхронним шляхом — там він
      // рахується без жодного виклику моделі. Порожня сторінка гірша за слабшу пораду.
      if (errStatus(e) === 400) {
        try {
          const res = await generate().unwrap();
          setFallback(res.fallback ? res : null);
          if (res.fallback) toast.info(t("adv.fallbackToast"));
          return;
        } catch { /* впав і fallback — покажемо чесну помилку нижче */ }
      }
      const raw = errText(e);
      const friendly = raw.includes("not set") ? t("adv.keyMissing") : t("adv.genFailed", { error: raw });
      setGenError(friendly);
      toast.error(friendly);
    }
  }

  const months = advice?.runway_months ?? null;
  const tone = months == null ? "accent" : months >= 6 ? "pos" : months >= 3 ? "warn" : "neg";

  return (
    <>
      <div className="page-head">
        <div>
          <div className="greet">{t("nav.advisor")}</div>
          <div className="sub">{t("adv.sub")}</div>
        </div>
        <div className="page-head-actions">
          <Link to="/chat" className="btn ghost">{t("adv.chatLink")} →</Link>
          {/* Головна дія сторінки — у шапці, а не всередині секції порад: там її не було видно
              (фідбек користувача). З вкладки «Стан фінансів» перекидає на «Поради», бо саме
              там з'явиться результат. */}
          <button className="btn primary" onClick={() => { setTab("advice"); void runAdvice(); }} disabled={generating}>
            <Icon name="spark" size={15} />
            {generating ? t("adv.analyzing") : advice ? t("adv.refresh") : t("adv.getAdvice")}
          </button>
        </div>
      </div>

      <div className="stat-tabs" role="tablist">
        {(Object.keys(TABS) as AdvTab[]).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`stat-tab ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>
            {t(TABS[k])}
          </button>
        ))}
      </div>

      {tab === "state" && (
        <div className="advisor-state">
          <HealthIndexCard />
          <NetworthCard />
          <SpendFloorCard />
          <CashflowCalendar />
          <FactsCard />
          <KnowledgeCorpusCard />
        </div>
      )}

      {tab === "advice" && (
      <div className="stack" style={{ gap: 18 }}>
        {/* Порада вже згенерована й лежить на сервері — сторінка просто чекає на неї. Без
            скелета перший кадр показував «ще немає поради», і той, у кого вона Є, встигав
            прочитати запрошення її створити. */}
        {loadingAdvice && <RunwaySkeleton />}
        {advice && (
          <div className="card runway-card">
            <Gauge
              ratio={months != null ? Math.max(0, months) / 12 : 0}
              center={months != null ? String(Math.max(0, months)) : "—"}
              sub={months != null ? t("adv.months") : t("adv.noData")}
              tone={tone}
            />
            <div className="runway-metrics">
              <Metric label={t("adv.realCushion")} v={<Money minor={advice.cushion} decimals={false} />} tone="pos"
                info={t("adv.realCushionInfo")} />
              {advice.debt > 0 && (
                <Metric label={t("adv.creditDebt")} v={<Money minor={advice.debt} decimals={false} />} tone="neg"
                  info={t("adv.creditDebtInfo")} />
              )}
              {advice.investment != null && advice.investment > 0 && (
                <Metric label={t("adv.investReserve")} v={<Money minor={advice.investment} decimals={false} />}
                  info={t("adv.investReserveInfo")} />
              )}
              {/* §BURN-SHAPE: the burn, with the part that does NOT repeat named under it. The bare
                  figure was the one the owner called impossible — it averages a quarterly tax and a
                  one-off dentist into every month, which is honest arithmetic and an unrecognisable
                  sentence. The sub-line is shown only when there IS a lump worth naming. */}
              <Metric label={t("adv.burnPerMonth")} v={<Money minor={advice.monthly_burn} decimals={false} />}
                info={advice.burn_lumpy ? t("adv.burnSplitInfo") : undefined}
                sub={advice.burn_lumpy && advice.burn_lumpy > 0
                  ? <>{t("adv.burnSplit", { n: "" })}<Money minor={advice.burn_lumpy} decimals={false} /></>
                  : undefined} />
              <Metric label={t("adv.cushionLasts")} v={months != null ? t("adv.monthsShort", { n: Math.max(0, months) }) : "—"} tone={tone}
                info={t("adv.cushionLastsInfo")} />
            </div>
            {/* Full-width second row — the span lives in `.runway-comment`, not inline, so it
                stays true if the card's columns ever change. */}
            {advice.runway_comment && <p className="runway-comment">{highlightAmounts(advice.runway_comment)}</p>}
          </div>
        )}

        <WhatIf />

        <div className="advisor-grid">
          {/* Головна колонка — структуровані поради */}
          <section className="advisor-main">
            {/* Кнопку генерації прибрано звідси — вона тепер у шапці сторінки (одна дія, одне місце). */}
            <div className="section-head">
              <h2>{t("adv.adviceOnNumbers")}</h2>
            </div>

            {advice?.suggestions?.length ? (
              <div className="stack">
                {/* Порада без AI мусить бути ПОЗНАЧЕНОЮ: інакше слабший детермінований
                    текст читається як повноцінний AI-розбір, і збій лишається невидимим. */}
                {advice.fallback && (
                  <div className="fb-note" role="status">
                    <Icon name="info" size={15} />
                    <div>
                      <b>{t("adv.noAiTitle")}</b>
                      {advice.fallback_reason ? ` ${advice.fallback_reason}` : ""}
                      {" "}{t("adv.noAiSuffix")}
                    </div>
                  </div>
                )}
                <SinceLastTime advice={advice} />
                {advice.summary && <p className="ai-text" style={{ margin: "0 2px 6px" }}>{renderRich(advice.summary)}</p>}
                {advice.suggestions.map((s, i) => (
                  <div key={s.key ?? i} className={`card advice-card${s.state === "dismissed" ? " sg-dismissed" : ""}`}>
                    <div className="advice-num">{i + 1}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="advice-title">{s.title}</div>
                      <div className="advice-detail">{renderRich(s.detail)}</div>
                      {s.action && <AdviceActionButton action={s.action} suggestion={s} />}
                      <SuggestionFooter s={s} />
                    </div>
                  </div>
                ))}
                <div className="row" style={{ justifyContent: "space-between", marginTop: 2 }}>
                  <span className="label">
                    {t("adv.asOf", { when: dateFmt({ day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format((advice?.generated_at ?? 0) * 1000) })}
                  </span>
                  <UsageCost usage={advice?.usage} />
                </div>
              </div>
            ) : loadingAdvice || generating ? (
              <AdviceSkeleton />
            ) : genError ? (
              <div className="card empty">{genError} <button className="btn ghost sm" style={{ marginLeft: 8 }} onClick={runAdvice} disabled={generating}>{t("adv.retry")}</button></div>
            ) : (
              <div className="card empty">{t("adv.emptyPrompt")}</div>
            )}
          </section>

          {/* Правий рейл — розбивка коштів + AI-огляд + історія (заповнює ширину) */}
          <aside className="stack advisor-rail" style={{ gap: 18 }}>
            {advice?.facts && advice.facts.length > 0 && (
              <div className="card" style={{ padding: 16 }}>
                <RichFacts facts={advice.facts} sign={signFor(advice.cur ?? 980)} />
              </div>
            )}
            <AiInsightCard days={30} />
            <AdviceHistory />
          </aside>
        </div>
      </div>
      )}
    </>
  );
}

// Дельта-пілюля: зміна метрики vs минулого разу. `goodUp` — чи «більше = краще»
// (runway/подушка так; burn навпаки — менше краще).
// ⚠️ §BASE-CUR: the two snapshots may have been generated in DIFFERENT currencies, and a delta
// between them would be meaningless — `SinceLastTime` is what decides whether to show it at all.
function DeltaPill({ cur, prev, goodUp, money, unit }: { cur: number | null; prev: number | null; goodUp: boolean; money?: boolean; unit?: string }) {
  const t = useT();
  if (cur == null || prev == null) return null;
  const diff = cur - prev;
  if (Math.abs(diff) < (money ? 100 : 0.05)) return <span className="cmp-delta flat">{t("adv.noChange")}</span>;
  const good = goodUp ? diff > 0 : diff < 0;
  const abs = money ? `${formatMinor(Math.abs(diff), { decimals: false })} ${baseSign()}` : `${Math.abs(Math.round(diff * 10) / 10)}${unit ?? ""}`;
  return <span className={`cmp-delta ${good ? "down" : "up"}`}>{diff > 0 ? "+" : "−"}{abs}</span>;
}

// §+1: «зміни від минулого разу» — порівняння поточної поради з попереднім знімком історії.
function SinceLastTime({ advice }: { advice: Advice }) {
  const t = useT();
  const { data: hist } = useGetAdviceHistoryQuery();
  const prev = (hist ?? []).find((h) => h.generated_at < advice.generated_at);
  if (!prev) return null;
  // §BASE-CUR: "since last time" subtracts two STORED snapshots. If they were generated in
  // different currencies the difference is not a change in spending, it is a change of unit —
  // and it would be shown as a win or a loss. Say nothing rather than something wrong.
  if ((prev.cur ?? 980) !== (advice.cur ?? 980)) return null;
  const dfmt = dateFmt({ day: "2-digit", month: "short" });
  return (
    <div className="card since-last" style={{ padding: "10px 14px" }}>
      <span className="label">{t("adv.sinceLastFrom", { date: dfmt.format(prev.generated_at * 1000) })}</span>
      <span className="since-metric">Runway <DeltaPill cur={advice.runway_months} prev={prev.runway_months} goodUp unit={t("adv.monthsAbbr")} /></span>
      <span className="since-metric">{t("adv.burnPerMonthCompact")} <DeltaPill cur={advice.monthly_burn} prev={prev.monthly_burn} goodUp={false} money /></span>
      <span className="since-metric">{t("adv.cushionShort")} <DeltaPill cur={advice.cushion} prev={prev.cushion ?? null} goodUp money /></span>
    </div>
  );
}

// §2/§+1: історія порад — тренд runway + знімки з дельтами; можна очистити.
function AdviceHistory() {
  const t = useT();
  const { data: hist } = useGetAdviceHistoryQuery();
  const [clear, { isLoading: clearing }] = useClearAdviceHistoryMutation();
  const [dropOne] = useDeleteAdviceHistoryEntryMutation();
  // The list is a log that grows to 24 entries, and the four that matter are always the newest.
  // The CHART keeps the whole series regardless — trimming a list must not trim a trend.
  const [showAll, setShowAll] = useState(false);
  if (!hist || hist.length < 2) return null;
  const dfmt = dateFmt({ day: "2-digit", month: "short" });
  const VISIBLE = 5;
  const rows = showAll ? hist : hist.slice(0, VISIBLE);
  const hidden = hist.length - rows.length;

  // Хронологічний ряд для тренду runway (від старих до нових; лише зі значенням).
  const chrono = [...hist].reverse();
  const runwayPts = chrono
    .filter((h) => h.runway_months != null)
    .map((h) => ({ t: h.generated_at, runway: h.runway_months as number, label: dfmt.format(h.generated_at * 1000) }));

  async function onClear() {
    if (!confirm(t("adv.clearConfirm"))) return;
    try { await clear().unwrap(); } catch { toast.error(t("adv.clearFailed")); }
  }

  return (
    <section>
      <div className="section-head">
        <h2>{t("adv.adviceHistory")}</h2>
        <button className="btn ghost sm" onClick={onClear} disabled={clearing}>{t("adv.clear")}</button>
      </div>

      {runwayPts.length >= 2 && (
        <div className="card" style={{ padding: "12px 8px 4px", marginBottom: 10 }}>
          <span className="label" style={{ padding: "0 8px" }}>{t("adv.runwayChartLabel")}</span>
          <div className="chart-wrap" style={{ height: 130 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={runwayPts} margin={{ top: 10, right: 10, left: Y_AXIS_LEFT_MARGIN, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--line)" strokeOpacity={0.6} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} dy={6} minTickGap={28} tick={{ fontSize: 11, fill: "var(--muted)" }} />
                <YAxis {...Y_AXIS} tickCount={4} />
                <Tooltip
                  cursor={{ stroke: "var(--line-strong)", strokeWidth: 1 }}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  content={(props: any) => {
                    const p = props?.active && props?.payload?.[0]?.payload;
                    return p ? <div className="chart-tip"><div className="tip-lbl">{p.label}</div><div className="r"><span className="d" style={{ background: "var(--accent)" }} />{p.runway} {t("adv.monthsUnit")}</div></div> : null;
                  }}
                />
                <Line type="monotone" dataKey="runway" stroke="var(--accent)" strokeWidth={2} strokeLinecap="round" dot={{ r: 2.5 }} activeDot={{ r: 3.5 }} {...CHART_ANIM} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      <div className="card" style={{ padding: 8 }}>
        {rows.map((h, i) => {
          const prev: AdviceHistoryItem | undefined = hist[i + 1]; // наступний = старіший
          return (
            <div key={h.generated_at} className="adv-hist-row">
              <span className="adv-hist-date">{dfmt.format(h.generated_at * 1000)}</span>
              <span className="adv-hist-sum">{h.summary || "—"}</span>
              <span className="adv-hist-nums">
                {h.runway_months != null && (
                  <>runway <b>{h.runway_months}{t("adv.monthsAbbr")}</b> {prev && <DeltaPill cur={h.runway_months} prev={prev.runway_months} goodUp unit={t("adv.monthsAbbr")} />} · </>
                )}
                burn <b><Money minor={h.monthly_burn} decimals={false} /></b>{t("adv.burnUnit")} {prev && <DeltaPill cur={h.monthly_burn} prev={prev.monthly_burn} goodUp={false} money />}
              </span>
              {/* Per-entry delete: «Очистити» is all-or-nothing, and one useless snapshot is not
                  a reason to burn the whole trend. */}
              <button
                className="adv-hist-del" aria-label={t("common.delete")} title={t("common.delete")}
                onClick={() => { void dropOne(h.generated_at); }}
              >×</button>
            </div>
          );
        })}
        {(hidden > 0 || showAll) && (
          <button className="adv-hist-more" onClick={() => setShowAll((v) => !v)}>
            {showAll ? t("adv.histShowLess") : t("adv.histShowMore", { n: hidden })}
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * §ADVICE-LOOP — the advice acts, and pressing it marks the suggestion as taken.
 *
 * ⚠️ Every branch below calls a mutation that ALREADY existed. A variant with no executor would be
 * a button that lies, which is worse than a paragraph that is honest about being a paragraph —
 * and it is why the action types are a closed union in `shared/api/ai.ts` rather than a free
 * string the model fills in.
 * ⚠️ The mark is set even when the mutation fails. Refusing to record it would mean a user who hit
 * a transient error is offered the same advice next month as if nothing had happened; they DID
 * decide, and the decision is the thing being remembered.
 */
function AdviceActionButton({ action, suggestion }: { action: AdviceAction; suggestion: AdviceSuggestion }) {
  const t = useT();
  const [setBudget] = useSetBudgetMutation();
  const [createGoal] = useCreateGoalMutation();
  const [deletePlanned] = useDeletePlannedMutation();
  const [createRule] = useCreateRuleMutation();
  const [mark] = useSetSuggestionStateMutation();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const minor = action.amount_uah != null ? Math.round(action.amount_uah * 100) : null;
  // Whether this particular action has everything it needs. A half-specified action renders
  // nothing rather than a button that fails on tap.
  const ready = (() => {
    switch (action.type) {
      case "create_budget":
      case "set_budget": return action.category_id != null && minor != null;
      case "create_goal": return !!action.goal_title && minor != null;
      case "cancel_subscription": return action.planned_id != null;
      case "create_rule": return !!action.match_pattern && action.category_id != null;
      default: return false;
    }
  })();
  if (!ready) return null;

  const run = async () => {
    switch (action.type) {
      case "create_budget":
      case "set_budget":
        await setBudget({ category_id: action.category_id!, period: "month", amount: minor! }).unwrap();
        break;
      case "create_goal":
        await createGoal({ title: action.goal_title!, target: minor! } as never).unwrap();
        break;
      case "cancel_subscription":
        await deletePlanned(action.planned_id!).unwrap();
        break;
      case "create_rule":
        await createRule({ match_type: "contains", pattern: action.match_pattern!, category_id: action.category_id! }).unwrap();
        break;
    }
  };

  return (
    <button
      className="btn primary sm" style={{ marginTop: 10 }}
      disabled={busy || done || suggestion.state === "done"}
      onClick={async () => {
        setBusy(true);
        try { await run(); } catch { /* the mark below is about the DECISION, not the request */ }
        try { await mark({ key: suggestion.key, state: "taken" }).unwrap(); } catch { /* ignore */ }
        setBusy(false);
        setDone(true);
      }}
    >
      {done ? t("adv.sgTaken") : (action.label || t("adv.createEnvelope"))}
    </button>
  );
}

/**
 * §I18N-DYNKEY — the state label is resolved through a MAP, never built as `adv.sgState_${state}`.
 * A key assembled from a value is a key neither `tsc` nor the parity check can see, so the day a
 * sixth state appears the screen shows the raw key and nothing fails first.
 */
const SG_STATE_KEY = {
  open: "adv.sgState_open",
  taken: "adv.sgState_taken",
  done: "adv.sgState_done",
  dismissed: "adv.sgState_dismissed",
} as const;

/**
 * §ADVICE-LOOP — where a suggestion stands, and what came of it.
 *
 * The outcome line is the half that makes this a loop rather than a checklist: it is computed from
 * the ledger by `scoreTakenSuggestions`, never written by the model, and it is the only place the
 * app can say «you did this, and here is what happened».
 */
function SuggestionFooter({ s }: { s: AdviceSuggestion }) {
  const t = useT();
  const [mark, { isLoading }] = useSetSuggestionStateMutation();
  const set = (state: SuggestionState) => mark({ key: s.key, state });
  if (!s.key) return null;   // advice generated before the loop existed
  return (
    <div className="sg-foot">
      {s.outcome && (
        <span className={`sg-outcome ${s.outcome.delta_pct <= 0 ? "pos" : "neg"}`}>
          {t("adv.sgOutcome", { pct: Math.abs(s.outcome.delta_pct), dir: t(s.outcome.delta_pct <= 0 ? "adv.sgDown" : "adv.sgUp") })}
        </span>
      )}
      {s.state === "open" ? (
        <>
          <button className="btn ghost xs" disabled={isLoading} onClick={() => set("done")}>{t("adv.sgMarkDone")}</button>
          <button className="btn ghost xs" disabled={isLoading} onClick={() => set("dismissed")}>{t("adv.sgDismiss")}</button>
        </>
      ) : (
        <>
          <span className="sg-state">{t(SG_STATE_KEY[s.state])}</span>
          <button className="btn ghost xs" disabled={isLoading} onClick={() => set("open")}>{t("adv.sgUndo")}</button>
        </>
      )}
    </div>
  );
}

function Metric({ label, v, tone, info, sub }: { label: string; v: React.ReactNode; tone?: string; info?: string; sub?: React.ReactNode }) {
  return (
    <div className="runway-metric">
      <div className="label" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>{label}{info && <InfoTip>{info}</InfoTip>}</div>
      <div className={`runway-val num-hero ${tone === "pos" ? "pos" : tone === "neg" ? "neg" : tone === "warn" ? "" : ""}`}>{v}</div>
      {sub && <div className="runway-sub">{sub}</div>}
    </div>
  );
}
