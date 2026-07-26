import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useGetBudgetsQuery, useGetByCategoryQuery, useGetCategoriesQuery } from "../../store/api.ts";
import { startOfMonthUnix } from "../../lib/format.ts";
import { Money } from "../ui/Money.tsx";
import { useT } from "../../i18n/index.ts";

// Конверти: кожна бюджетна категорія — кишеня, що спорожняється в міру витрат (§8).
export function EnvelopeGrid() {
  const t = useT();
  const from = startOfMonthUnix();
  const to = Math.floor(Date.now() / 1000);
  const { data: budgets } = useGetBudgetsQuery();
  const { data: cats } = useGetCategoriesQuery();
  const { data: spend } = useGetByCategoryQuery({ from, to });

  const envelopes = useMemo(() => {
    if (!budgets || !cats) return [];
    const catById = new Map(cats.map((c) => [c.id, c]));
    const spentByCat = new Map<number, number>();
    for (const s of spend ?? []) {
      // §Аналітика 2.0: by-category тепер канонічний і зведений у ₴ (одна сума на категорію).
      if (s.category_id != null) {
        spentByCat.set(s.category_id, (spentByCat.get(s.category_id) ?? 0) + Math.abs(s.spent));
      }
    }
    return budgets
      .filter((bd) => bd.category_id != null && bd.period === "month")
      .map((bd) => {
        const cat = catById.get(bd.category_id!);
        const spent = spentByCat.get(bd.category_id!) ?? 0;
        const ratio = bd.amount > 0 ? Math.min(spent / bd.amount, 1) : 0;
        return {
          id: bd.category_id!,
          name: cat?.name ?? "—",
          color: cat?.color ?? "#6B7A74",
          spent,
          budget: bd.amount,
          pct: Math.round(ratio * 100),
          remain: bd.amount - spent,
          over: spent > bd.amount,
        };
      })
      .sort((a, b) => b.pct - a.pct); // спершу найнапруженіші конверти
  }, [budgets, cats, spend]);

  if (!envelopes.length) {
    return (
      <Link to="/plan" className="card empty" style={{ display: "block" }}>
        {t("eg.empty")}
      </Link>
    );
  }

  return (
    <div className="env-list">
      {envelopes.map((e) => {
        const state = e.over ? "over" : e.pct >= 80 ? "warn" : "ok";
        const bar = state === "over" ? "var(--neg)" : state === "warn" ? "var(--warn, #c9871a)" : e.color;
        return (
          <Link to="/plan" key={e.id} className={`env-item ${state}`}>
            <div className="env-top">
              <span className="env-name"><span className="d" style={{ background: e.color }} />{e.name}</span>
              <span className={`env-pct ${state}`}>{e.pct}%</span>
            </div>
            <div className="env-bar"><span style={{ transform: `scaleX(${Math.min(e.pct, 100) / 100})`, background: bar }} /></div>
            <div className="env-sub">
              <span><Money minor={e.spent} decimals={false} /> {t("common.of")} <Money minor={e.budget} decimals={false} /></span>
              <span className="env-remain">
                {e.remain >= 0 ? <>{t("eg.left")} <Money minor={e.remain} decimals={false} /></> : <>{t("eg.exceeded")}</>}
              </span>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
