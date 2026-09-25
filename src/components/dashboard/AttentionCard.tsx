/**
 * «Потребує уваги» — the dashboard's to-do list, built from signals the app already computes
 * elsewhere (UI_PASS S11). Every row names ONE thing and links to the screen where it is fixed.
 *
 * Why it exists: by 2026-09 the app knew a lot that the dashboard never said — a subscription whose
 * charge did not arrive (§PLAN-STATE, only visible on /subs), an envelope heading over its limit
 * (only as a colour in the grid, below the fold), transfers waiting for their real category (only
 * on Statistics). Each was right where it lived and invisible from the one screen opened daily.
 *
 * ⚠️ Composed on the CLIENT from existing queries, not a new endpoint: each source already has its
 * canonical judgement (plan state, envelope projection, pending transfers), and a server-side
 * «attention» route would be a second place deciding what «late» or «over» means.
 * ⚠️ Silent sources are silent: a failed or empty query contributes no row, and «all clear» is
 * said only when EVERY source answered — a card that says «nothing to do» because its requests
 * failed is the confident wrong answer this app keeps refusing to give.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useT } from "../../i18n/index.ts";
import { dateFmt } from "../../i18n/locale.ts";
import {
  useGetPlannedQuery, useGetPlannedActualsQuery, useGetBudgetStatusQuery, useGetTransfersStatusQuery,
  useGetSpendingShapeQuery,
} from "../../store/api.ts";
import { Icon } from "../ui/Icon.tsx";
import { ErrorNote } from "../ui/ErrorNote.tsx";
import { envelopeState } from "../../../shared/envelope.ts";
import { localMonthStart, nowUnix } from "../../../shared/time.ts";

const fmtDay = dateFmt({ day: "numeric", month: "short" });

/** Rows shown before «ще N». One more than this is shown whole — «ще 1» costs the row it hides. */
const SHOWN = 5;

type Item = { key: string; tone: "bad" | "warn" | "info"; icon: string; text: string; sub?: string; to: string };

export function AttentionCard() {
  const t = useT();
  const [all, setAll] = useState(false);
  const plans = useGetPlannedQuery();
  const actuals = useGetPlannedActualsQuery();
  const budgets = useGetBudgetStatusQuery();
  const transfers = useGetTransfersStatusQuery();
  // Frozen for the life of the card: a `to` recomputed every render is a new cache key every
  // second, and RTK would refetch the shape on each re-render.
  // Kyiv month (§APP_TZ): the server groups by it, so the browser's own zone must not pick the month.
  const win = useMemo(() => {
    const now = nowUnix();
    return { from: localMonthStart(now), to: now };
  }, []);
  const shape = useGetSpendingShapeQuery({ ...win, currency: null });

  const items: Item[] = [];

  // §PLAN-STATE — a scheduled outflow whose latest cycle has no charge. «Not linked» ≠ «not paid»
  // (§PLAN-LATE), so the row asks the reader to look, it does not claim a debt.
  const byId = new Map((actuals.data ?? []).map((a) => [a.id, a]));
  for (const p of plans.data ?? []) {
    if (!p.is_active || p.kind === "income") continue;
    const st = byId.get(p.id)?.state;
    if (!st || st.due_at == null || !(st.kind === "late" || st.kind === "missing" || st.kind === "stopped")) continue;
    items.push({
      key: `plan-${p.id}`, tone: st.kind === "late" ? "warn" : "bad", icon: "repeat",
      text: t(st.kind === "late" ? "att.planLate" : st.kind === "missing" ? "att.planMissing" : "att.planStopped", { title: p.title }),
      sub: t("att.expected", { date: fmtDay.format(st.due_at * 1000) }),
      to: `/subs/${p.id}`,
    });
  }

  // Envelopes: over, exactly spent (§ENV-STATE — rent equal to its envelope is not an overspend),
  // or heading over on the same rule the grid uses (`projected_ratio ≥ 1.05`, never for a lump).
  for (const b of budgets.data ?? []) {
    if (b.amount <= 0) continue;
    const st = envelopeState(b);
    if (st === "over" || st === "full") {
      items.push({ key: `bud-${b.id}`, tone: st === "over" ? "bad" : "warn", icon: "target", text: t(st === "over" ? "att.budgetOver" : "att.budgetFull", { name: b.name }), sub: t("att.budgetOverSub", { pct: Math.round(b.ratio * 100) }), to: `/categories/${b.id}` });
    } else if (!b.lumpy && b.projected_ratio >= 1.05) {
      items.push({ key: `bud-${b.id}`, tone: "warn", icon: "target", text: t("att.budgetPace", { name: b.name }), sub: t("att.budgetPaceSub", { pct: Math.round(b.projected_ratio * 100) }), to: `/categories/${b.id}` });
    }
  }

  const pending = transfers.data?.pending ?? 0;
  if (pending > 0) {
    items.push({ key: "transfers", tone: "info", icon: "swap", text: t("att.transfers", { n: pending }), sub: t("att.transfersSub"), to: "/stats?tab=categories" });
  }

  // A few uncategorised rows are the daily AI pass's job (§AI-CATCHUP) and not worth a line.
  const uncat = shape.data?.uncategorised.n ?? 0;
  if (uncat >= 3) {
    items.push({ key: "uncat", tone: "info", icon: "tag", text: t("att.uncat", { n: uncat }), sub: t("att.uncatSub"), to: "/stats?tab=trends" });
  }

  const order = { bad: 0, warn: 1, info: 2 } as const;
  items.sort((a, b) => order[a.tone] - order[b.tone]);
  const sources = [plans, actuals, budgets, transfers, shape];
  const answered = sources.every((q) => q.isSuccess);
  const failed = sources.find((q) => q.isError);
  // Nothing to list AND a source failed: say so, rather than vanish or claim «all clear».
  if (!items.length && failed) {
    return <ErrorNote error={failed.error} what={t("att.title")} onRetry={() => sources.forEach((q) => q.isError && q.refetch())} />;
  }
  if (!items.length && !answered) return null;

  return (
    <section>
      <div className="section-head"><h2>{t("att.title")}</h2>{items.length > 0 && <span className="label">{items.length}</span>}</div>
      <div className="card flush">
        {items.length === 0 ? (
          <div className="att-clear"><Icon name="check" size={16} />{t("att.clear")}</div>
        ) : (
          <ul className="ilist">
            {/* Five, then «ще N» in place (F7): a silent `slice(0, 6)` under a header counting all
                of them hid the rest with nothing to say they existed. */}
            {(all || items.length <= SHOWN + 1 ? items : items.slice(0, SHOWN)).map((it) => (
              <li key={it.key}>
                <Link to={it.to} className={`att-row ${it.tone}`}>
                  <span className="att-ico"><Icon name={it.icon} size={15} /></span>
                  <span className="att-body">
                    <span className="att-text">{it.text}</span>
                    {it.sub && <span className="att-sub">{it.sub}</span>}
                  </span>
                </Link>
              </li>
            ))}
            {!all && items.length > SHOWN + 1 && (
              <li>
                <button type="button" className="att-more" onClick={() => setAll(true)}>
                  {t("att.more", { n: items.length - SHOWN })}
                </button>
              </li>
            )}
          </ul>
        )}
      </div>
    </section>
  );
}
