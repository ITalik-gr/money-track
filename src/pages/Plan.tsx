import { useMemo, useState } from "react";
import { useT } from "../i18n/index.ts";
import { Link } from "react-router-dom";
import {
  useGetBudgetsQuery,
  useGetByCategoryQuery,
  useGetBudgetStatusQuery,
  useGetCategoriesQuery,
  useBudgetChatMutation,
  useSetBudgetMutation,
  useCreateJobMutation,
  useGetJobsQuery,
} from "../store/api.ts";
import { Money } from "../components/ui/Money.tsx";
import { Icon } from "../components/ui/Icon.tsx";
import { BudgetCardsSkeleton } from "../components/ui/Skeleton.tsx";
import { AutoBudget } from "../components/planning/AutoBudget.tsx";
import { startOfMonthUnix } from "../lib/format.ts";
import { highlightAmounts } from "../lib/highlight.tsx";
import { toast } from "../lib/toast.ts";
import type { BudgetProposalRow, BudgetPlanResult } from "../store/api.ts";

// Планування (§7): місячні бюджети-конверти по категоріях. Підписки — окрема сторінка.
export function Plan() {
  const t = useT();
  return (
    <>
      <div className="page-head">
        <div>
          <div className="greet">{t("plan.title")}</div>
          <div className="sub">{t("plan.sub")}</div>
        </div>
      </div>
      <div className="stack" style={{ gap: 18 }}>
        <AutoBudget />
        <BudgetChat />
        <BudgetPlanner />
        <section>
          <div className="section-head">
            <h2>{t("plan.allCategories")}</h2>
            <Link to="/categories" className="label group-link">{t("plan.manageCategories")} →</Link>
          </div>
          <Budgets />
        </section>
      </div>
    </>
  );
}

// §3: діалоговий бюджет — опиши, що хочеш, AI пропонує ліміти й пояснює чому; можна обговорити.
type ChatMsg = { role: "user" | "assistant"; content: string };
function BudgetChat() {
  const tr = useT();
  const [setBudget] = useSetBudgetMutation();
  const [chat, { isLoading }] = useBudgetChatMutation();
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [proposals, setProposals] = useState<{ category_id: number; limit_uah: number; reason: string }[]>([]);
  const [input, setInput] = useState("");
  const { data: cats } = useGetCategoriesQuery();
  const catName = (id: number) => (cats ?? []).find((c) => c.id === id)?.name ?? `#${id}`;

  async function send(text: string) {
    const t = text.trim();
    if (!t || isLoading) return;
    const next = [...msgs, { role: "user" as const, content: t }];
    setMsgs(next);
    setInput("");
    try {
      const res = await chat({ messages: next }).unwrap();
      const reply = res.reply?.trim() || (res.proposals?.length ? tr("plan.chatReplyDefault") : "…");
      setMsgs([...next, { role: "assistant", content: reply }]);
      // Не затираємо попередні пропозиції порожнім набором (напр. коли відповідь — просто пояснення).
      if (res.proposals?.length) setProposals(res.proposals);
    } catch (e) {
      // Показуємо реальну причину з бекенду (напр. «ANTHROPIC_API_KEY not set», 502), а не глухе «не відповів».
      const msg = (e as { data?: { error?: string } })?.data?.error;
      toast.error(msg ? tr("plan.chatFailedWithMsg", { msg }) : tr("plan.chatFailed"));
      setMsgs(next); // лишаємо запит користувача, прибираємо «завислий» стан
    }
  }

  async function accept(p: { category_id: number; limit_uah: number }) {
    await setBudget({ category_id: p.category_id, period: "month", amount: Math.round(p.limit_uah * 100) }).unwrap();
    setProposals((ps) => ps.filter((x) => x.category_id !== p.category_id));
    toast.success(tr("plan.limitSetToast", { name: catName(p.category_id) }));
  }
  async function acceptAll() {
    for (const p of proposals) await setBudget({ category_id: p.category_id, period: "month", amount: Math.round(p.limit_uah * 100) }).unwrap();
    setProposals([]);
    toast.success(tr("plan.allLimitsApplied"));
  }

  const starters = [tr("plan.starter1"), tr("plan.starter2"), tr("plan.starter3")];

  return (
    <section>
      <div className="section-head"><h2>{tr("plan.chatTitle")}</h2><span className="label">{tr("plan.chatSub")}</span></div>
      <div className="card" style={{ padding: 16 }}>
        {msgs.length === 0 && (
          <div className="stack" style={{ gap: 10, marginBottom: 16 }}>
            <p className="ai-block-hint" style={{ margin: 0 }}>{tr("plan.chatHint")}</p>
            <div className="bch-starters">
              {starters.map((s) => <button key={s} className="bch-starter" onClick={() => send(s)}>{s}</button>)}
            </div>
          </div>
        )}
        {msgs.length > 0 && (
          <div className="bch-msgs">
            {msgs.map((m, i) => (
              <div key={i} className={`bch-msg ${m.role}`}>{m.role === "assistant" ? highlightAmounts(m.content) : m.content}</div>
            ))}
            {isLoading && <div className="bch-msg assistant muted">{tr("plan.thinking")}</div>}
          </div>
        )}

        {proposals.length > 0 && (
          <div className="bch-proposals">
            <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
              <span className="label">{tr("plan.proposedLimits")}</span>
              <button className="btn primary sm" onClick={acceptAll}>{tr("plan.acceptAll")}</button>
            </div>
            {proposals.map((p) => (
              <div key={p.category_id} className="bch-prop">
                <div style={{ minWidth: 0 }}>
                  <div className="bch-prop-name">{catName(p.category_id)} · <b><Money minor={p.limit_uah * 100} decimals={false} /></b></div>
                  {p.reason && <div className="bch-prop-reason">{p.reason}</div>}
                </div>
                <button className="btn sm" onClick={() => accept(p)}>{tr("plan.accept")}</button>
              </div>
            ))}
          </div>
        )}

        <div className="bch-input">
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={tr("plan.msgPlaceholder")}
            onKeyDown={(e) => { if (e.key === "Enter") send(input); }} disabled={isLoading} />
          <button className="btn primary" onClick={() => send(input)} disabled={isLoading || !input.trim()}>→</button>
        </div>
      </div>
    </section>
  );
}

// AI-планувальник: пропонує ліміти з історії + цілей, приймаєш одним тапом.
function BudgetPlanner() {
  const t = useT();
  // §A6: план рахується у фоні. `budget` — єдиний вид задачі без власного сховища, тож його
  // результат приїжджає в `result_json` рядка задачі, а не окремим ендпоінтом.
  const [createJob, { isLoading: queueing }] = useCreateJobMutation();
  const { data: jobs } = useGetJobsQuery();
  const budgetJobs = (jobs?.items ?? []).filter((j) => j.kind === "budget");
  const isLoading = queueing || budgetJobs.some((j) => j.status === "queued" || j.status === "running");
  const last = budgetJobs.find((j) => j.status === "done" || j.status === "failed");
  const isError = last?.status === "failed";
  const data = useMemo<BudgetPlanResult | undefined>(() => {
    if (!last?.result_json) return undefined;
    try { return JSON.parse(last.result_json) as BudgetPlanResult; } catch { return undefined; }
  }, [last?.result_json]);
  const propose = () => createJob({ kind: "budget" });
  const [setBudget] = useSetBudgetMutation();
  const [accepted, setAccepted] = useState<Set<number>>(new Set());

  async function acceptOne(r: BudgetProposalRow) {
    await setBudget({ category_id: r.category_id, period: "month", amount: r.suggested }).unwrap();
    setAccepted((s) => new Set(s).add(r.category_id));
  }
  async function acceptAll() {
    if (!data) return;
    for (const r of data.rows) await setBudget({ category_id: r.category_id, period: "month", amount: r.suggested }).unwrap();
    setAccepted(new Set(data.rows.map((r) => r.category_id)));
  }

  return (
    <section>
      <div className="section-head">
        <h2>{t("plan.aiPlanTitle")}</h2>
        <button className="btn primary sm" onClick={() => propose()} disabled={isLoading}>
          {isLoading ? t("plan.analyzing") : data ? t("plan.refresh") : <><Icon name="spark" size={15} />{t("plan.proposeLimits")}</>}
        </button>
      </div>

      {isError && <div className="card" style={{ padding: "12px 16px", color: "var(--neg)", fontSize: 13.5 }}>{t("plan.planFailed")}</div>}

      {!data && !isLoading && !isError && (
        <div className="card empty">{t("plan.planEmpty")}</div>
      )}

      {data && (
        <div className="card" style={{ padding: 16 }}>
          {data.overall && <p className="ai-text" style={{ margin: "0 0 12px" }}>{highlightAmounts(data.overall)}</p>}
          <div className="bp-list">
            {data.rows.map((r) => {
              const delta = r.avg_month > 0 ? Math.round(((r.suggested - r.avg_month) / r.avg_month) * 100) : null;
              const on = accepted.has(r.category_id);
              return (
                <div className={`bp-item ${on ? "done" : ""}`} key={r.category_id}>
                  <div className="bp-item-main">
                    <span className="bp-name"><span className="d" style={{ background: r.color ?? "var(--muted)" }} />{r.name}</span>
                    <span className="bp-figs">
                      <span className="bp-avg">{t("stats.avgShort")} <Money minor={r.avg_month} decimals={false} /></span>
                      <span className="bp-arrow">→</span>
                      <span className="bp-sug"><Money minor={r.suggested} decimals={false} /></span>
                      {delta != null && delta !== 0 && (
                        <span className={`cmp-delta ${delta < 0 ? "down" : "up"}`}>{delta > 0 ? "+" : ""}{delta}%</span>
                      )}
                    </span>
                    <button className="btn bp-accept" onClick={() => acceptOne(r)} disabled={on}>
                      {on ? t("plan.added") : t("plan.accept")}
                    </button>
                  </div>
                  {r.reason && <div className="bp-reason">{r.reason}</div>}
                </div>
              );
            })}
          </div>
          <button className="btn primary" style={{ marginTop: 12 }} onClick={acceptAll}>{t("plan.acceptAllLimits")}</button>
        </div>
      )}
    </section>
  );
}

function Budgets() {
  const t = useT();
  const { data: cats, isLoading: loadingCats } = useGetCategoriesQuery();
  const { data: budgets } = useGetBudgetsQuery();
  const [setBudget] = useSetBudgetMutation();

  // §3: факт за поточний місяць — канонічний by-category (₴, рол-ап у батька). Потрібен і далі:
  // категорія БЕЗ конверта не має рядка в `/budgets/status`, а картка все одно показує її факт.
  const from = startOfMonthUnix();
  const to = Math.floor(Date.now() / 1000);
  const { data: spend } = useGetByCategoryQuery({ from, to });
  /**
   * §BUDGET-MEMORY — перенесений залишок приходить ГОТОВИМ із канону.
   *
   * Раніше він рахувався тут: `max(0, ліміт − витрати минулого місяця)` з окремого запиту. Три
   * помилки в одному рядку. (1) Це було ЧЕТВЕРТЕ визначення числа, яким володіє `budgetStatus`,
   * тож сторінка Плану показувала один ефективний ліміт, а сітка конвертів, стрічка й пуш у
   * Telegram — інший, для того самого конверта. (2) `max(0, …)` мовчки викидав ПЕРЕВИТРАТУ:
   * зекономлене переносилось, перевитрачене — ні, і конверт ставав грою, у якій не можна програти.
   * (3) За «ліміт минулого місяця» бралося сьогоднішнє значення, тож правка ліміту заднім числом
   * переписувала те, що нібито перенеслось у липні.
   */
  const { data: status } = useGetBudgetStatusQuery();
  const statusById = useMemo(
    () => new Map((status ?? []).map((s) => [s.id, s])),
    [status],
  );

  const limits = useMemo(() => {
    const m = new Map<number, number>();
    for (const b of budgets ?? []) if (b.category_id != null && b.period === "month") m.set(b.category_id, b.amount);
    return m;
  }, [budgets]);
  const rollovers = useMemo(() => {
    const s = new Set<number>();
    for (const b of budgets ?? []) if (b.category_id != null && b.period === "month" && b.rollover) s.add(b.category_id);
    return s;
  }, [budgets]);

  const spentByCat = useMemo(() => {
    const m = new Map<number, number>();
    for (const s of spend ?? []) if (s.category_id != null) m.set(s.category_id, (m.get(s.category_id) ?? 0) + Math.abs(s.spent));
    return m;
  }, [spend]);

  // Верхньорівневі витратні категорії (бюджет тримаємо на батьках — узгоджено з рол-апом).
  const topCats = (cats ?? []).filter((c) => !c.is_income && c.parent_id == null);
  // Сортуємо: спершу з лімітом, потім за фактом спадання.
  const ordered = [...topCats].sort((a, b) => {
    const la = limits.has(a.id) ? 1 : 0, lb = limits.has(b.id) ? 1 : 0;
    if (la !== lb) return lb - la;
    return (spentByCat.get(b.id) ?? 0) - (spentByCat.get(a.id) ?? 0);
  });

  // «Завантаження» і «категорій справді нема» — різні стани, і другий раніше показувався
  // текстом про перший, тобто порожній акаунт виглядав як вічний спінер.
  if (loadingCats) return <BudgetCardsSkeleton />;
  if (!ordered.length) return <div className="card empty">{t("plan.noCats")}</div>;

  return (
    <div className="budget-cards">
      {ordered.map((c) => {
        const limit = limits.get(c.id) ?? 0;
        const st = statusById.get(c.id);
        return (
          <BudgetCard
            key={c.id}
            name={c.name}
            color={c.color}
            limit={limit}
            // Витрата з конверта, коли він є, — те саме число, що в сітці конвертів; інакше
            // канонічний by-category. Обидва рахує сервер.
            spent={st?.spent ?? spentByCat.get(c.id) ?? 0}
            rollover={rollovers.has(c.id)}
            carried={st?.carried ?? 0}
            onSave={(minor, rollover) => setBudget({ category_id: c.id, period: "month", amount: minor, rollover })}
          />
        );
      })}
    </div>
  );
}

function BudgetCard({
  name, color, limit, spent, rollover, carried, onSave,
}: { name: string; color: string | null; limit: number; spent: number; rollover: boolean; carried: number; onSave: (minor: number, rollover: boolean) => void }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(limit ? String(limit / 100) : "");
  const dot = color ?? "#8A948F";

  // §BUDGET-MEMORY: ефективний ліміт = базовий + перенесене. `carried` приходить із канону й
  // може бути ВІД'ЄМНИМ — перевитрачений місяць з'їдає наступний рівно так само, як зекономлений
  // його наповнює. Без цієї симетрії конверт обіцяє наслідки, яких не настає.
  const carry = rollover ? carried : 0;
  const effLimit = limit + carry;
  const ratio = effLimit > 0 ? spent / effLimit : 0;
  const pct = Math.round(ratio * 100);
  const remain = effLimit - spent;
  const state = limit === 0 ? "none" : ratio > 1 ? "over" : ratio >= 0.8 ? "warn" : "ok";
  const barColor = state === "over" ? "var(--neg)" : state === "warn" ? "var(--warn, #c9871a)" : dot;

  function save() {
    const minor = Math.round(Number(val || 0) * 100);
    if (minor !== limit) onSave(minor, rollover);
    setEditing(false);
  }

  return (
    <div className={`budget-card ${state}`}>
      <div className="bc-head">
        <span className="bc-name"><span className="d" style={{ background: dot }} />{name}</span>
        {/* Перенесений залишок — видимий бейдж, а не рядок у лейблі чекбокса:
            він змінює ліміт цього місяця, тож має читатись відразу. */}
        {carry !== 0 && (
          <span className={`bc-carry ${carry < 0 ? "neg" : ""}`} title={t("plan.carryTitle")}>
            {carry > 0 ? "+" : "−"}<Money minor={Math.abs(carry)} decimals={false} />{" "}
            {carry > 0 ? t("plan.carryFromLast") : t("plan.carryDebtFromLast")}
          </span>
        )}
        {limit > 0
          ? <span className={`bc-pct ${state}`}>{pct}%</span>
          : <button className="bc-set" onClick={() => setEditing(true)}>{t("plan.setLimit")}</button>}
      </div>

      <div className="bc-bar">
        <span style={{ transform: `scaleX(${Math.min(pct, 100) / 100})`, background: barColor }} />
        {/* Засічка на межі БАЗОВОГО ліміту — видно, де закінчується «свій» місяць
            і починається перенесене. Без неї смуга мовчки розтягується. */}
        {carry > 0 && effLimit > 0 && (
          <i className="bc-tick" style={{ left: `${Math.min(99, (limit / effLimit) * 100)}%` }}
            title={t("plan.baseLimitTitle", { amount: Math.round(limit / 100) })} />
        )}
      </div>

      <div className="bc-foot">
        <span className="bc-spent"><Money minor={spent} decimals={false} /> {t("plan.spent")}</span>
        {editing ? (
          <span className="bc-edit">
            <input type="number" inputMode="decimal" autoFocus placeholder={t("plan.limitPlaceholder")}
              value={val} onChange={(e) => setVal(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }}
              onBlur={save} />
          </span>
        ) : limit > 0 ? (
          <button className="bc-limit" onClick={() => { setVal(String(limit / 100)); setEditing(true); }} title={t("plan.changeLimit")}>
            {remain >= 0
              ? <>{t("plan.remaining")} <b><Money minor={remain} decimals={false} /></b></>
              : <>{t("plan.exceededBy")} <b className="neg"><Money minor={-remain} decimals={false} /></b></>}
            <span className="bc-of"> {t("plan.ofLimit")} <Money minor={effLimit} decimals={false} /></span>
          </button>
        ) : null}
      </div>

      {limit > 0 && (
        <label className="bc-roll" title={t("plan.rolloverTitle")}>
          <input type="checkbox" checked={rollover} onChange={(e) => onSave(limit, e.target.checked)} />
          <span>{t("plan.rollover")}</span>
        </label>
      )}
    </div>
  );
}
