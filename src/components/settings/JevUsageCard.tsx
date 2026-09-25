/**
 * §JEV-SHARED — the owner's view of the TypeSafe key lent to accounts without their own.
 *
 * The owner decided to lend it (2026-09-25: «джев не дорогий, то норм») on one condition: seeing
 * what it eats. Calls, input tokens and dollars for today / this month / all time, and who used it
 * this month. Live — the directory is written on every judgment — so no refresh button.
 */
import { useT } from "../../i18n/index.ts";
import { numFmt } from "../../i18n/locale.ts";
import { useGetJevUsageQuery } from "../../store/api.ts";
import { Icon } from "../ui/Icon.tsx";
import { ErrorNote } from "../ui/ErrorNote.tsx";

const n0 = numFmt({ maximumFractionDigits: 0 });
const usd = (v: number) => "$" + (v > 0 && v < 0.01 ? v.toFixed(4) : v.toFixed(2));

export function JevUsageCard() {
  const t = useT();
  const { data, error, refetch } = useGetJevUsageQuery();
  if (error) return <ErrorNote error={error} what={t("jevuse.title")} onRetry={refetch} />;
  if (!data) return null;
  const tiles = [
    { label: t("setup.aiToday"), p: data.today },
    { label: t("setup.aiMonth"), p: data.month },
    { label: t("setup.aiTotal"), p: data.total },
  ];
  return (
    <div className="card set-card set-full">
      <div className="set-card-h"><Icon name="spark" size={16} />{t("jevuse.title")}</div>
      <p className="set-card-sub">{data.enabled ? t("jevuse.sub") : t("jevuse.off")}</p>
      <div className="ai-usage-row">
        {tiles.map((x) => (
          <div key={x.label} className="ai-usage-tile">
            <span className="label">{x.label}</span>
            <span className="ai-usage-cost num-hero">{usd(x.p.cost_usd)}</span>
            <span className="ai-usage-calls muted">{t("jevuse.calls", { n: n0.format(x.p.calls), tok: n0.format(x.p.input_tokens) })}</span>
          </div>
        ))}
      </div>
      {data.users.length > 0 ? (
        <div className="jevuse-list">
          <span className="label">{t("jevuse.who")}</span>
          {data.users.map((u) => (
            <div key={u.user_id} className="jevuse-row">
              <span className="jevuse-mail">{u.email ?? u.user_id}</span>
              <span className="muted">{t("jevuse.calls", { n: n0.format(u.calls), tok: n0.format(u.input_tokens) })}{u.today_calls > 0 ? ` · ${t("jevuse.today", { n: u.today_calls })}` : ""}</span>
              <b>{usd(u.cost_usd)}</b>
            </div>
          ))}
        </div>
      ) : data.enabled && <p className="set-card-sub" style={{ margin: "10px 0 0" }}>{t("jevuse.none")}</p>}
    </div>
  );
}
