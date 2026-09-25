// Індекс фінздоровʼя — компактна версія для рейлу Головної.
// Повна картка (`HealthIndexCard`) із розкладом по складових живе на Пораднику; тут —
// лише «скільки» + «куди рухається», щоб дашборд відповідав на питання за пів секунди.
// Той самий ендпоінт і той самий скор — двох різних «індексів здоровʼя» бути не може.
import { ErrorNote } from "../ui/ErrorNote.tsx";
import { Link } from "react-router-dom";
import { useGetHealthQuery } from "../../store/api.ts";
import { Gauge } from "../ui/Gauge.tsx";
import { Sparkline } from "../ui/Sparkline.tsx";
import { useT } from "../../i18n/index.ts";
import type { TranslationKey } from "../../i18n/index.ts";

const BAND_KEY: Record<string, TranslationKey> = { good: "band.good", ok: "band.ok", risk: "band.risk" };

export function HealthMini() {
  const t = useT();
  const { data, error, refetch } = useGetHealthQuery();
  // C17: silence while loading is right on the rail; silence on a FAILED request is a lie by omission.
  if (error) return <ErrorNote error={error} what={t("hm.title")} onRetry={refetch} />;
  // Мовчимо, поки не порахувалось: скелет заради скелета на рейлі — це шум.
  if (!data) return null;

  const { score, band } = data;
  // §HEALTH: a provisional index (less than half the formula measurable — a new account) shows no
  // number and no band: «100 · добре» on an empty account is a verdict on nothing.
  const provisional = data.insufficient;
  const tone = provisional ? "accent" : score >= 70 ? "pos" : score >= 45 ? "warn" : "neg";
  const trend = data.trend ?? [];
  const delta = trend.length >= 2 ? trend[trend.length - 1].score - trend[0].score : null;

  return (
    <Link to="/advisor?tab=state" className="card hm" title={t("hm.open")}>
      <Gauge ratio={provisional ? 0 : score / 100} center={provisional ? "—" : String(score)} sub={t("hm.of100")} tone={tone} size={82} />
      <div className="hm-body">
        <div className="hm-label">{t("hm.title")}</div>
        <div className={`hm-band ${provisional ? "idle" : tone}`}>
          {provisional ? t("hm.provisional") : BAND_KEY[band] ? t(BAND_KEY[band]) : band}
        </div>
        {trend.length >= 2 && (
          <div className="hm-trend">
            <Sparkline values={trend.map((t) => t.score)} width={78} height={20} color="var(--muted)" goodUp />
            {delta != null && delta !== 0 && (
              <span className={`hm-delta ${delta > 0 ? "pos" : "neg"}`}>
                {delta > 0 ? "+" : "−"}{Math.abs(delta)}
              </span>
            )}
          </div>
        )}
      </div>
    </Link>
  );
}
