/**
 * §SPEND-PROFILE — three facts about the BEHAVIOUR behind a period, drawn as three plain figures.
 *
 * Deliberately not a chart. Each of these is one number with one sentence under it, and a chart
 * would be decoration around a fact that is already the size of a fact. The block earns its place
 * because nothing else on the page answers any of the three:
 *   • quiet days — two months with the same total are different months if one had eleven days
 *     where nothing was bought;
 *   • concentration — the merchants tab RANKS merchants and never says how few of them are half
 *     of a life;
 *   • new faces — §HABITS names recurring merchants that appeared or went quiet; this measures
 *     MONEY, which is the difference between a month spent repeating and one spent exploring.
 *
 * All three come from the server over the same canonical population as the total above them, so
 * the shares here are shares of the figure the page already prints.
 */
import { useT } from "../../i18n/index.ts";
import { formatMinor } from "../../lib/format.ts";
import { useGetSpendProfileQuery } from "../../store/api.ts";
import { ErrorNote } from "../ui/ErrorNote.tsx";
import { FactLabel } from "./shared.tsx";

export function SpendProfileBlock({ from, to, sign }: { from: number; to: number; sign: string }) {
  const t = useT();
  const { data, error, refetch } = useGetSpendProfileQuery({ from, to });

  // Empty and broken look identical when a block simply disappears, and this one has no other way
  // to say which happened (§Обробка помилок).
  if (error) return <ErrorNote error={error} what={t("stats.profile.title")} onRetry={refetch} />;
  if (!data || data.total <= 0) return null;

  const pct = (v: number) => Math.round(v * 100);

  return (
    <section>
      <div className="section-head">
        <h2>{t("stats.profile.title")}</h2>
        <span className="label">{t("stats.profile.sub")}</span>
      </div>
      <div className="card sp-grid">
        <div className="sp-item">
          <FactLabel info={<>{t("stats.profile.quietInfo")}</>}>{t("stats.profile.quiet")}</FactLabel>
          <div className="sp-val">
            {data.quiet_days.quiet}
            <span className="sp-of"> / {data.quiet_days.days}</span>
          </div>
          <div className="sp-note">
            {data.quiet_days.longest_streak > 1
              ? t("stats.profile.quietStreak", { n: data.quiet_days.longest_streak })
              : t("stats.profile.quietNoStreak")}
          </div>
        </div>

        <div className="sp-item">
          <FactLabel info={<>{t("stats.profile.concInfo")}</>}>{t("stats.profile.conc")}</FactLabel>
          <div className="sp-val">{data.concentration.merchants_for_half}</div>
          <div className="sp-note">
            {t("stats.profile.concNote", {
              n: data.concentration.merchants,
              pct: pct(data.concentration.top5_share),
            })}
          </div>
        </div>

        <div className="sp-item">
          <FactLabel info={<>{t("stats.profile.freshInfo")}</>}>{t("stats.profile.fresh")}</FactLabel>
          <div className="sp-val">
            {pct(data.new_faces.share)}<span className="sp-of">%</span>
          </div>
          <div className="sp-note">
            {t("stats.profile.freshNote", {
              n: data.new_faces.merchants,
              amount: `${formatMinor(data.new_faces.spent, { decimals: false })} ${sign}`,
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
