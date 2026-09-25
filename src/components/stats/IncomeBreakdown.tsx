import { useGetIncomeAnalyticsQuery } from "../../store/api.ts";
import { formatMinor, monthShort } from "../../lib/format.ts";
import { HoverTip, TipBody } from "../ui/HoverTip.tsx";
import { ErrorNote } from "../ui/ErrorNote.tsx";
import { useT } from "../../i18n/index.ts";

// §1 Аналітика доходу: джерела (по категоріях), стабільність (варіативність 6 міс) і
// дельта проти минулого періоду. Зведено в ₴. Дзеркалить канон Статистики.
const FALLBACK = ["#12805c", "#2e6be6", "#7a3e9d", "#c9871a", "#127c86", "#6b7a74"];
// ST5: tone and words from the server's machine `level`. They used to be looked up by the LOCALISED
// label against Ukrainian words, so an English screen always said «moderate».
const stabTone = { stable: "pos", moderate: "warn", volatile: "neg" } as const;
const stabLabelKey = { stable: "inc.stabStable", moderate: "inc.stabModerate", volatile: "inc.stabUnstable" } as const;
const stabDescKey = { stable: "inc.descStable", moderate: "inc.descModerate", volatile: "inc.descUnstable" } as const;

export function IncomeBreakdown({ preset, from, to, currency, sign }: {
  preset: string; from?: number; to?: number; currency: number | null; sign: string;
}) {
  const t = useT();
  // §MONTH-VIEW: when the page is showing a named month, so is this block. It used to ask for the
  // trailing preset regardless — the one block still reporting on «now» under a July heading.
  const { data, error, refetch } = useGetIncomeAnalyticsQuery({ preset, from, to, currency });
  // A block that just disappears says "nothing here" for both an empty period and a failed
  // request; only the empty half is an answer (§Обробка помилок).
  if (error) return <ErrorNote error={error} what={t("inc.title")} onRetry={refetch} />;
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
  const level = data.stability.level;
  const tone = level ? stabTone[level] : "";
  // What the spread MEANS, in money: the weakest and the strongest complete month (the running one
  // is half a month and would always be «the weakest»).
  const complete = data.monthly.slice(0, -1).filter((m) => m.income > 0);
  const weakest = complete.length >= 2 ? complete.reduce((a, b) => (b.income < a.income ? b : a)) : null;
  const strongest = complete.length >= 2 ? complete.reduce((a, b) => (b.income > a.income ? b : a)) : null;
  const mLabel = (ym: string) => monthShort(Number(ym.split("-")[1]) - 1);
  const money = (m: number) => `${formatMinor(m, { decimals: false })} ${sign}`;

  return (
    <section>
      <div className="section-head">
        <h2>{t("inc.title")}</h2>
        <span className="label">{t("inc.subtitle")}</span>
      </div>
      <div className="inc-grid">
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
            <span className={`stab-badge ${tone}`}>{level ? t(stabLabelKey[level]) : data.stability.label}</span>
            {data.stability.cv_pct != null && <span className="muted" style={{ fontSize: 12.5 }}>{t("inc.stabDispersion", { pct: data.stability.cv_pct })}</span>}
          </div>
          <div className="inc-months">
            {data.monthly.map((m, i) => {
              const running = i === data.monthly.length - 1;
              return (
                // ST5: the tip says WHAT arrived that month — a jumpy month is only useful once it
                // names the payment that was missing or doubled.
                <HoverTip key={m.month} content={<TipBody label={<>{mLabel(m.month)}{running ? ` · ${t("spark.running")}` : ""}</>} value={money(m.income)}
                  sub={m.top.length ? <>{m.top.map((s) => <div key={s.name}>{s.name} · {money(s.amount)}</div>)}</> : t("inc.noneThisPeriod")} />}>
                  <div className={`im-col${running ? " running" : ""}`}>
                    <span className="im-val">{m.income > 0 ? formatMinor(m.income, { decimals: false }) : "—"}</span>
                    <div className="im-bar-wrap"><div className="im-bar" style={{ height: `${(m.income / monMax) * 100}%` }} /></div>
                    <span className="im-lbl">{mLabel(m.month)}</span>
                  </div>
                </HoverTip>
              );
            })}
          </div>
          <p className="deep-desc">
            {level ? t(stabDescKey[level]) : t("inc.descModerate")}
            {weakest && strongest && weakest.month !== strongest.month && (
              <> {t("inc.range", { low: money(weakest.income), lowM: mLabel(weakest.month), high: money(strongest.income), highM: mLabel(strongest.month) })}</>
            )}
          </p>
        </div>
      </div>
    </section>
  );
}
