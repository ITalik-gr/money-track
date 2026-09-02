/**
 * §CAT-SHAPE — three findings about the SHAPE of one category, under the figures that say its size.
 *
 * Each one is null on the server whenever the evidence cannot carry it, and each one renders
 * nothing at all in that case. That is deliberate and it is the whole difference between this
 * block and a dashboard: a flat weekday chart drawn from nine charges looks exactly like a flat
 * weekday chart drawn from nine hundred, and the reader has no way to tell which they are looking
 * at. A missing block says «we cannot tell» in the only way a chart never can.
 *
 * ⚠️ The weekday half reuses `wd-*`, the classes §WEEKDAY already owns. A private copy would be a
 * FIFTH declaration of those rules (four exist, and the duplication is a known open bug) — and the
 * copies would drift apart exactly where nobody looks, since they are never on screen together.
 */
import { useT } from "../../i18n/index.ts";
import { formatMinor, weekdayShort } from "../../lib/format.ts";
import { useGetCategoryShapeQuery } from "../../store/api.ts";
import { IMPORTANCE_META, type Importance } from "../../lib/importance.ts";
import { ErrorNote } from "../ui/ErrorNote.tsx";
import { HoverTip } from "../ui/HoverTip.tsx";
import { Money } from "../ui/Money.tsx";

export function CategoryShapeBlocks({ id, from, to, hasBudget }: {
  id: number; from: number; to: number;
  /**
   * Whether the page is already showing an envelope for this category.
   *
   * The envelope card carries its own projection, computed by `budgetStatus` from the same
   * `projectSpend` — so printing ours beside it would be the same number twice, and the reader
   * would reasonably wonder which one to believe when rounding made them differ by a hryvnia.
   * The projection here exists for the category that has a LEVEL but no envelope, which is most
   * of them.
   */
  hasBudget: boolean;
}) {
  const t = useT();
  const { data, error, refetch } = useGetCategoryShapeQuery({ id, from, to });

  // A block that just disappears says "nothing here" for both an unanswerable question and a
  // failed request; only the first is an answer (§Обробка помилок).
  if (error) return <ErrorNote error={error} what={t("cat.shapeTitle")} onRetry={refetch} />;
  if (!data) return null;

  const wd = data.weekday;
  const max = wd ? Math.max(...wd.days.map((d) => d.typical), 1) : 1;
  // Monday first: `dow` follows SQL (0 = Sunday) and the reader lives in a week that starts with a
  // working day. Display order is the reader's question, not the database's.
  const ordered = wd ? [1, 2, 3, 4, 5, 6, 0].map((n) => wd.days.find((d) => d.dow === n)!) : [];

  const imp = data.importance ?? [];
  // One level is a fact, not a chart: a bar with a single segment is a rectangle. It is still worth
  // SAYING — «усе тут обовʼязкове» is an answer — so it becomes a line instead.
  const impBar = imp.length > 1;
  const impMeta = (level: string) => IMPORTANCE_META[level as Importance] ?? null;

  const showProjection = data.projection && !hasBudget;

  if (!wd && !data.dom && !imp.length && !showProjection) return null;

  return (
    <>
      {imp.length > 0 && (
        <section>
          <div className="section-head">
            <h2>{t("cat.impTitle")}</h2>
            <HoverTip content={<>{t("cat.impTip")}</>}>
              <span className="label">{t("cat.impSub")}</span>
            </HoverTip>
          </div>
          <div className="card cat-imp">
            {impBar && (
              <div className="cat-imp-bar">
                {imp.map((r) => (
                  <div
                    key={r.level}
                    className="cat-imp-seg"
                    style={{ width: `${r.share_pct}%`, background: impMeta(r.level)?.color ?? "var(--muted)" }}
                    title={`${t(impMeta(r.level)?.labelKey ?? "cat.impTitle")} · ${r.share_pct}%`}
                  />
                ))}
              </div>
            )}
            <div className="cat-imp-legend">
              {imp.map((r) => (
                <div key={r.level} className="cat-imp-row">
                  <span className="d" style={{ background: impMeta(r.level)?.color ?? "var(--muted)" }} />
                  <span className="cat-imp-name">{t(impMeta(r.level)?.labelKey ?? "cat.impTitle")}</span>
                  <span className="cat-imp-pct num-mono">{r.share_pct}%</span>
                  <span className="cat-imp-amt num-mono"><Money minor={r.spent} decimals={false} /></span>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {showProjection && data.projection && (
        <section>
          <div className="section-head">
            <h2>{t("cat.projTitle")}</h2>
            <span className="label">{t("cat.projSub", { pct: data.projection.elapsed_pct })}</span>
          </div>
          <div className="card cat-proj">
            <div className="cat-proj-main">
              <Money minor={data.projection.projected} decimals={false} />
            </div>
            <div className="cat-proj-note">
              {/* A lump is stated, not hidden. `projectSpend` deliberately refuses to extrapolate
                  one — so the figure above is «what already happened», and calling it a forecast
                  without saying so would promise a precision the number does not have. */}
              {data.projection.lumpy
                ? t("cat.projLumpy")
                : t("cat.projVsUsual", {
                  usual: formatMinor(data.projection.usual, { decimals: false }),
                  delta: Math.round(((data.projection.projected - data.projection.usual) / data.projection.usual) * 100),
                })}
            </div>
            <div className="cat-proj-sofar label">
              {t("cat.projSoFar", { spent: formatMinor(data.projection.spent, { decimals: false }) })}
            </div>
          </div>
        </section>
      )}

      {(wd || data.dom?.busiest != null || data.dom?.first_five_share_pct != null) && (
        <section>
          <div className="section-head">
            <h2>{t("cat.whenTitle")}</h2>
            <HoverTip content={<>{t("wd.tip")}</>}>
              <span className="label">{t("cat.whenSub")}</span>
            </HoverTip>
          </div>
          <div className="card" style={{ padding: 16 }}>
            {wd && (
              <div className="wd-grid">
                {ordered.map((d) => {
                  const weekend = d.dow === 0 || d.dow === 6;
                  return (
                    <div key={d.dow} className={`wd-col${weekend ? " weekend" : ""}`}>
                      <div className="wd-bar-wrap">
                        {/* A day carried by ONE payment is drawn differently rather than hidden:
                            it is still true, just not about behaviour. */}
                        <div
                          className={`wd-bar${d.lumpy ? " lumpy" : ""}${d.dow === wd.busiest ? " busiest" : ""}`}
                          style={{ height: `${Math.round((d.typical / max) * 100)}%` }}
                          title={t("wd.barTitle", { n: d.n, days: d.days })}
                        />
                      </div>
                      <div className="wd-val num-mono">{formatMinor(d.typical, { decimals: false })}</div>
                      <div className="wd-label label">{weekdayShort(d.dow)}</div>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="wd-foot">
              {wd?.busiest != null && <span>{t("wd.busiest", { day: weekdayShort(wd.busiest) })}</span>}
              {data.dom?.busiest != null && (
                <span className="muted">
                  {t("cat.domBusiest", { dom: data.dom.busiest, n: data.dom.busiest_n })}
                </span>
              )}
              {data.dom?.first_five_share_pct != null && data.dom.first_five_share_pct >= 40 && (
                <span className="muted">{t("cat.domFirstFive", { pct: data.dom.first_five_share_pct })}</span>
              )}
            </div>
          </div>
        </section>
      )}
    </>
  );
}
