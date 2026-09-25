/**
 * Goals on the dashboard rail (UI_PASS S11): the two open goals closest to done, each a name, a
 * bar and what is left — the goal page stays the place to act on them.
 *
 * «Closest to done» rather than «nearest deadline»: a goal without a deadline is the common case,
 * and the one about to be reached is the one that answers «am I getting anywhere».
 * Silent without goals: an empty rail card would be an advert for a feature on the daily screen.
 */
import { Link } from "react-router-dom";
import { useT } from "../../i18n/index.ts";
import { useGetGoalsQuery } from "../../store/api.ts";
import { Money } from "../ui/Money.tsx";
import { HoverTip, TipBody } from "../ui/HoverTip.tsx";
import { ErrorNote } from "../ui/ErrorNote.tsx";

export function GoalsMini() {
  const t = useT();
  const { data, isError, error, refetch } = useGetGoalsQuery();
  if (isError) return <ErrorNote error={error} what={t("gm.title")} onRetry={refetch} />;
  const open = (data ?? []).filter((g) => g.pace && g.pace.status !== "done");
  if (!open.length) return null;
  const top = [...open].sort((a, b) => b.pace.progress_frac - a.pace.progress_frac).slice(0, 2);

  return (
    <section>
      <div className="section-head">
        <h2>{t("gm.title")}</h2>
        <Link to="/goals" className="label group-link">{t("common.all")} →</Link>
      </div>
      <div className="card gm-card">
        {top.map((g) => {
          const pct = Math.round(g.pace.progress_frac * 100);
          const color = g.color ?? "var(--accent)";
          return (
            <Link key={g.id} to="/goals" className="gm-row">
              <span className="gm-head">
                <span className="gm-name">{g.name}</span>
                <span className="gm-pct">{pct}%</span>
              </span>
              <HoverTip content={<TipBody label={g.name} color={color}
                value={<Money minor={g.current} currency={g.currency_code} decimals={false} />}
                sub={<>{t("goal.ofTarget")} <Money minor={g.target_amount} currency={g.currency_code} decimals={false} /> · {t("tip.left")} <Money minor={g.pace.left} currency={g.currency_code} decimals={false} /></>} />}>
                <span className="gm-bar"><i style={{ width: `${Math.min(100, pct)}%`, background: color }} /></span>
              </HoverTip>
              <span className="gm-sub">{t("tip.left")} <Money minor={g.pace.left} currency={g.currency_code} decimals={false} /></span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
