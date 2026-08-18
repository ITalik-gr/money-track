import { Link } from "react-router-dom";
import { dateFmt } from "../../i18n/locale.ts";
import { useGetUpcomingSubsQuery } from "../../store/api.ts";
import { MerchantLogo } from "../ui/MerchantLogo.tsx";
import { Money } from "../ui/Money.tsx";
import { EmptyCard } from "../ui/EmptyCard.tsx";
import { formatMinor } from "../../lib/format.ts";
import { useT } from "../../i18n/index.ts";
import type { TranslationKey } from "../../i18n/index.ts";
import { baseSign } from "../../lib/currency.ts";

// §4 «Скоро спишеться»: планові платежі/підписки у горизонті 30 днів — лого бренду,
// дата, «через N дн». Перетинає межу місяця (на відміну від прогнозу місяця).
const fmtDay = dateFmt({ day: "numeric", month: "short" });

// Returns a translation key (+ params) rather than text, so rendering stays reactive to the
// active locale — resolving the string here would freeze it to whatever locale was active.
function whenLabel(days: number): { key: TranslationKey; params?: Record<string, number>; urgent: boolean } {
  if (days <= 0) return { key: "when.today", urgent: true };
  if (days === 1) return { key: "when.tomorrow", urgent: true };
  return { key: "when.inDays", params: { days }, urgent: days <= 3 };
}

export function UpcomingSubs() {
  const t = useT();
  const { data } = useGetUpcomingSubsQuery(30);
  if (!data) return null; // still loading — a placeholder here would flash on every visit
  // ROADMAP L3: loaded-but-empty gets an empty-state, not null. This card sits in a `.dash-pair`
  // next to the forecast, so vanishing left half the row blank.
  if (data.items.length === 0) {
    return (
      <section>
        <div className="section-head">
          <h2>{t("us.title")}</h2>
          <Link to="/subs" className="label group-link">{t("link.subs")} →</Link>
        </div>
        <EmptyCard icon="repeat" title={t("empty.subs.title")} hint={t("empty.subs.hint")}
          to="/subs" action={t("empty.subs.action")} />
      </section>
    );
  }

  return (
    <section>
      <div className="section-head">
        <h2>{t("us.title")}</h2>
        <Link to="/subs" className="label group-link">{t("link.subs")} →</Link>
      </div>
      <div className="card up-subs">
        <div className="up-subs-total">
          <span className="label">{t("us.over30")}</span>
          <span className="num-hero" style={{ fontSize: 22 }}><Money minor={data.total} decimals={false} /></span>
        </div>
        <div className="up-subs-list">
          {data.items.slice(0, 6).map((s) => {
            const w = whenLabel(s.days_until);
            return (
              <div key={s.id} className="up-sub">
                <MerchantLogo merchant={s.title} color={null} fallbackLabel={s.title} />
                <div className="us-mid">
                  <span className="us-name">{s.title}</span>
                  <span className={`us-when ${w.urgent ? "urgent" : ""}`}>{t(w.key, w.params)} · {fmtDay.format(s.at * 1000)}</span>
                </div>
                {/* Показуємо у ВАЛЮТІ ПЛАНУ («$5»), а не сирим числом із ₴-значком —
                    саме через це CLOUDFLARE $5 виглядав як 5 ₴. ₴-еквівалент — підписом. */}
                <span className="us-amt">
                  <Money minor={s.amount} currency={s.currency_code} decimals={false} />
                  {s.currency_code !== 980 && (
                    <span className="us-amt-uah">≈ {formatMinor(s.amount_uah, { decimals: false })} {baseSign()}</span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
