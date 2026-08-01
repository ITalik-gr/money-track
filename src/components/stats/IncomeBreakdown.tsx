import { useGetIncomeAnalyticsQuery } from "../../store/api.ts";
import { formatMinor, monthShort } from "../../lib/format.ts";
import { HoverTip } from "../ui/HoverTip.tsx";
import { useT, type TranslationKey } from "../../i18n/index.ts";

// §1 Аналітика доходу: джерела (по категоріях), стабільність (варіативність 6 міс) і
// дельта проти минулого періоду. Зведено в ₴. Дзеркалить канон Статистики.
const FALLBACK = ["#12805c", "#2e6be6", "#7a3e9d", "#c9871a", "#127c86", "#6b7a74"];
const stabTone: Record<string, string> = { стабільний: "pos", помірний: "warn", нестабільний: "neg" };
// Сервер (P3.4, ще не локалізовано) віддає лейбл стабільності Ukrainian-словом — мапимо
// на ключ перекладу для показу, порівняння в описі нижче лишаються по сирому значенню.
const stabLabelKey: Record<string, TranslationKey> = { стабільний: "inc.stabStable", помірний: "inc.stabModerate", нестабільний: "inc.stabUnstable" };

export function IncomeBreakdown({ preset, currency, sign }: { preset: string; currency: number | null; sign: string }) {
  const t = useT();
  const { data } = useGetIncomeAnalyticsQuery({ preset, currency });
  if (!data) return null;
  // ⚠️ НЕ `data.total === 0` (як було). Стабільність рахується за 6 ПОВНИХ місяців і лишається
  // осмисленою, навіть коли в поточному періоді надходжень ще не було — а блок зникав цілком:
  // 1-го числа місяця вся аналітика доходу просто щезала зі сторінки, і це читалось як «фічу
  // видалили» (скарга 2026-08-01). Ховаємо лише тоді, коли історії НЕМА ЗОВСІМ — тобто коли
  // показувати справді нічого.
  const hasHistory = data.monthly.some((m) => m.income > 0);
  if (data.total === 0 && !hasHistory) return null;

  const srcMax = Math.max(...data.sources.map((s) => s.amount), 1);
  const monMax = Math.max(...data.monthly.map((m) => m.income), 1);
  const delta = data.delta_pct;
  const tone = stabTone[data.stability.label] ?? "";

  return (
    <section>
      <div className="section-head">
        <h2>{t("inc.title")}</h2>
        <span className="label">{t("inc.subtitle")}</span>
      </div>
      <div className="stats-2col">
        <div className="card deep-card">
          <div className="inc-head">
            <div>
              <span className="label">{t("inc.periodIncomeLabel")}</span>
              <div className="num-hero" style={{ fontSize: 30 }}>{formatMinor(data.total, { decimals: false })}<span className="cur" style={{ fontSize: "0.5em", color: "var(--muted)", marginLeft: 4 }}>{sign}</span></div>
            </div>
            {delta != null && delta !== 0 && (
              <span className={`cmp-delta ${delta > 0 ? "down" : "up"}`} title={t("inc.vsLastPeriodTitle")}>{delta > 0 ? "+" : ""}{delta}%</span>
            )}
          </div>
          <div className="inc-sources">
            {/* Порожній період — це стан, а не порожнє місце: без явного рядка панель джерел
                виглядала б як така, що не догрузилась. */}
            {data.sources.length === 0 && <div className="inc-empty">{t("inc.noneThisPeriod")}</div>}
            {data.sources.slice(0, 6).map((s, i) => (
              <div key={s.category_id ?? i} className="inc-src">
                <span className="is-name"><span className="d" style={{ background: s.color ?? FALLBACK[i % FALLBACK.length] }} />{s.name}</span>
                <span className="is-track"><span style={{ width: `${(s.amount / srcMax) * 100}%`, background: s.color ?? FALLBACK[i % FALLBACK.length] }} /></span>
                <span className="is-val">{formatMinor(s.amount, { decimals: false })} {sign} <span className="muted">· {s.pct}%</span></span>
              </div>
            ))}
          </div>
        </div>

        <div className="card deep-card">
          <div className="deep-title">
            {t("inc.stabilityTitle")}{" "}
            <HoverTip content={<>{t("inc.stabilityTip")}</>}>
              <span className="label" style={{ fontWeight: 400 }}>· {t("common.whatIsThis")}</span>
            </HoverTip>
          </div>
          <div className="inc-stab">
            <span className={`stab-badge ${tone}`}>{stabLabelKey[data.stability.label] ? t(stabLabelKey[data.stability.label]) : data.stability.label}</span>
            {data.stability.cv_pct != null && <span className="muted" style={{ fontSize: 12.5 }}>{t("inc.stabDispersion", { pct: data.stability.cv_pct })}</span>}
          </div>
          <div className="inc-months">
            {data.monthly.map((m, i) => (
              <HoverTip key={i} content={<><div className="tip-lbl">{monthShort(Number(m.month.split("-")[1]) - 1)}</div><div className="r">{formatMinor(m.income, { decimals: false })} {sign}</div></>}>
                <div className="im-col">
                  <div className="im-bar-wrap"><div className="im-bar" style={{ height: `${(m.income / monMax) * 100}%` }} /></div>
                  <span className="im-lbl">{monthShort(Number(m.month.split("-")[1]) - 1)}</span>
                </div>
              </HoverTip>
            ))}
          </div>
          <p className="deep-desc">
            {data.stability.label === "стабільний" ? t("inc.descStable") :
             data.stability.label === "нестабільний" ? t("inc.descUnstable") :
             t("inc.descModerate")}
          </p>
        </div>
      </div>
    </section>
  );
}
