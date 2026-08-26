import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { Y_AXIS, Y_AXIS_LEFT_MARGIN } from "../lib/chart.ts";
import { dateFmt, numFmt } from "../i18n/locale.ts";
import { useT } from "../i18n/index.ts";
import { useGetCategoryOverviewQuery, useGetCategoryDrillQuery, useGetTransactionsQuery } from "../store/api.ts";
import { TransactionList } from "../components/transactions/TransactionList.tsx";
import { Money } from "../components/ui/Money.tsx";
import { ErrorNote } from "../components/ui/ErrorNote.tsx";
import { InfoTip } from "../components/ui/InfoTip.tsx";
import { formatMinor, startOfMonthUnix } from "../lib/format.ts";
import { CHART_ANIM } from "../lib/motion.ts";
import { DeltaChip } from "../components/stats/shared.tsx";
import { baseSign } from "../lib/currency.ts";
import { importanceMeta } from "../lib/importance.ts";

/**
 * §CATEGORY-PAGE — one category, linkable.
 *
 * The drill panel inside the Stats tab already answered "what is in this category", but it could
 * not be linked, bookmarked or reached from a budget — so the app's PRIMARY axis was the one thing
 * you could not open. (You could open a merchant.) This page is that permalink, plus the three
 * things a page needs and a drill panel does not: the canonical monthly level, a twelve-month
 * trend, and the envelope.
 *
 * Every number is server-computed canon — the level from `categoryMonthlyLevels`, the envelope
 * from `budgetStatus`, the trend and the split from `STATS_JOINS`. Recomputing any of them here
 * would be how this screen ends up disagreeing with the donut it was opened from.
 */
const fmt0 = numFmt({ maximumFractionDigits: 0 });
// `dateFmt` resolves the tag per CALL, so a module-level formatter still follows a language switch.
const fmtDay = dateFmt({ day: "numeric", month: "short", year: "numeric" });
const monthShort = dateFmt({ month: "short" });
const monthLabel = (m: string) => {
  // The month comes from an explicit `YYYY-MM` key, never from a timestamp: formatting a period
  // boundary in the local zone puts the end of June into July (CLAUDE.md, "month of a chart").
  const [y, mm] = m.split("-");
  return monthShort.format(new Date(Number(y), Number(mm) - 1, 1));
};

/**
 * The bounds of a `YYYY-MM` key, for the drill under the trend.
 *
 * Local midnight, matching `rangeFrom` above and `startOfMonthUnix`: the key itself was built in
 * Kyiv by the server (§APP_TZ), and re-deriving it from a timestamp here is the mistake that puts
 * the end of June into July.
 */
function monthBounds(ym: string): [number, number] {
  const [y, m] = ym.split("-").map(Number);
  return [
    Math.floor(new Date(y, m - 1, 1).getTime() / 1000),
    Math.floor(new Date(y, m, 1).getTime() / 1000) - 1,
  ];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CTooltip(props: any) {
  const { active, payload } = props;
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="chart-tip">
      <div className="tip-lbl">{p.label}</div>
      <div className="r"><span className="d" style={{ background: "var(--accent)" }} />{fmt0.format(p.spent)} {baseSign()}</div>
    </div>
  );
}

/**
 * §CAT-PAGE — the window the page is looking at.
 *
 * `month` stays the default because the envelope tile is month-to-date by definition and the two
 * must describe the same period. The rest exist because the owner opened categories that were
 * quiet this month and read an empty screen as lost data — the fix is partly the lifetime block
 * below, and partly simply being able to look further back.
 */
const RANGES = ["month", "quarter", "year", "all"] as const;
type Range = typeof RANGES[number];

function rangeFrom(r: Range, now: number): number {
  const d = new Date(now * 1000);
  if (r === "month") return startOfMonthUnix();
  if (r === "quarter") return Math.floor(new Date(d.getFullYear(), d.getMonth() - 2, 1).getTime() / 1000);
  if (r === "year") return Math.floor(new Date(d.getFullYear(), d.getMonth() - 11, 1).getTime() / 1000);
  return 0; // all — the server clamps to the first transaction anyway
}

export function Category() {
  const t = useT();
  const id = Number(useParams().id);
  const [range, setRange] = useState<Range>("month");
  const to = Math.floor(Date.now() / 1000);
  const from = rangeFrom(range, to);

  // Which month of the trend is opened underneath it. A bar is the only place on this page where
  // a number stands for a set of operations you can actually name, so it is the one that should
  // open (asked for after the chart went live).
  const [openMonth, setOpenMonth] = useState<string | null>(null);

  const { data, isError, error, refetch } = useGetCategoryOverviewQuery({ id, from, to });
  const { data: drill } = useGetCategoryDrillQuery({ category: id, from, to });
  const monthWin = openMonth ? monthBounds(openMonth) : null;
  const { data: monthRows, isFetching: monthLoading } = useGetTransactionsQuery(
    // A parent must include its sub-categories (`catparent`), a leaf must not — the same
    // distinction `CatScope` makes on the server. Getting it backwards would show a list that
    // does not add up to the bar above it.
    monthWin
      ? { ...(data?.is_sub ? { category: id } : { catparent: id }), from: monthWin[0], to: monthWin[1], limit: 200 }
      : { limit: 0 },
    { skip: !monthWin },
  );

  if (isError) return <ErrorNote error={error} what={t("nav.categories")} onRetry={refetch} />;
  if (!data) return null;

  const impLabel = importanceMeta(data.importance)?.labelKey;
  const rangeLabel = t(`cat.range.${range}` as "cat.range.month");
  const chart = data.trend.map((m) => ({ ...m, label: monthLabel(m.month), spent: Math.round(m.spent / 100) }));
  const total = data.recurring + data.oneoff;
  // §CAT-PAGE: an income bucket has no spending, no envelope and no canonical level — the page
  // keeps its shape but changes what it claims. Without this it rendered zeros over a category
  // holding every hryvnia the user earned.
  const inc = data.is_income;
  // "Nothing in this window" and "nothing ever" are different sentences, and telling them apart is
  // the entire bug report. `lifetime` is window-independent precisely so this check is possible.
  const emptyWindow = total === 0 && data.lifetime.n > 0;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="greet">
            <span className="d cat-page-dot" style={{ background: data.color ?? "var(--muted)" }} />
            {data.name}
          </div>
          {/*
            The label comes from `IMPORTANCE_META`, the canonical set of three — NOT from a key
            assembled as `imp.${level}`. That concatenation printed the raw key «imp.optional» on
            every optional category, because `imp.*` is a two-item pair belonging to SafeToSpend
            (which only shows two levels) and nothing could see the gap: the i18n lint checks that
            uk and en AGREE, and both were missing it. A key built at runtime is invisible to it by
            construction — which is the general lesson, not just this line.
          */}
          <div className="sub">{impLabel ? t(impLabel) : ""}</div>
        </div>
        <div className="page-head-actions">
          <div className="seg">
            {RANGES.map((r) => (
              <button key={r} className={`seg-btn ${range === r ? "active" : ""}`} onClick={() => setRange(r)}>
                {t(`cat.range.${r}` as "cat.range.month")}
              </button>
            ))}
          </div>
          <Link className="btn ghost" to="/stats">{t("cat.backToStats")}</Link>
        </div>
      </div>

      <div className="cat-page-stats">
        {/* The level FIRST: it is the answer to "how much does this cost me", which is the reason
            anyone opens a category. The period total is secondary — it depends on today's date. */}
        {/* §CAT-PAGE: the canonical level is spend-only and rolls up, so it exists for exactly one
            case — a top-level expense category. Everywhere else the lifetime average answers the
            same question honestly instead of quoting a number about a DIFFERENT category. */}
        <div className="card merchant-stat">
          <div className="label">
            {data.level ? t("cat.levelLabel") : t("cat.perActiveMonth")}
            <InfoTip>
              {/* Both of these are MONTHLY by definition and deliberately ignore the range (the
                  canon is month-defined, §CAT-PAGE). The tile beside them follows the range, so
                  the difference has to be stated — two tiles side by side, one of which quietly
                  answers about a different period, is the confusion this page already had once. */}
              {data.level
                ? (data.level.fixed ? t("cat.levelFixed") : t("cat.levelVariable"))
                : t("cat.perActiveMonthHint")}
              {" "}{t("cat.levelLabelHint")}
            </InfoTip>
          </div>
          <div className="merchant-stat-v num-hero">
            {data.level
              ? <Money minor={data.level.level} decimals={false} />
              : data.lifetime.per_active_month > 0
                ? <Money minor={data.lifetime.per_active_month} decimals={false} />
                : "—"}
          </div>
          <div className="merchant-stat-sub">
            {data.level
              ? t("cat.levelMonths", { n: data.level.active_months })
              : t("cat.levelMonths", { n: data.lifetime.active_months })}
          </div>
        </div>
        <div className="card merchant-stat">
          {/*
            The label carries the RANGE (2026-08-21). It used to read «За цей місяць», hardcoded,
            while the selector above it could be set to a year or to all time — so the tile stated
            one period and counted another, and the owner reported exactly that: «міняю на весь
            час, а воно все одно показує що за місяць». A label that can go out of step with its
            own number should not be able to: it is now built from the same state as the query.
          */}
          <div className="label">{t(inc ? "cat.periodEarned" : "cat.periodSpent", { range: rangeLabel })}</div>
          <div className="merchant-stat-v num-hero"><Money minor={total} decimals={false} /></div>
          {/* §E1: the split is the useful half — a big month made of one purchase means something
              different from the same month made of forty. */}
          {total > 0 && (
            <div className="merchant-stat-sub">
              {t("cat.recurringShare", { pct: Math.round((data.recurring / total) * 100) })}
            </div>
          )}
        </div>
        {/* Два питання, які сторінка досі не ставила — і які просять протилежних дій. */}
        {data.avg_check && (
          <div className="card merchant-stat">
            <div className="label">
              {t("cat.avgCheck")}
              <InfoTip>{t("cat.avgCheckHint")}</InfoTip>
            </div>
            <div className="merchant-stat-v num-hero"><Money minor={data.avg_check.now} decimals={false} /></div>
            <div className="merchant-stat-sub">
              {/* The COUNT is shown beside the delta on purpose: a category that grew did so
                  either through more charges or through dearer ones, and only these two numbers
                  together say which. */}
              {data.avg_check.prev != null
                ? <>
                    <DeltaChip a={data.avg_check.now} b={data.avg_check.prev} />
                    {" "}{t("cat.avgCheckOps", { n: data.avg_check.n, prev: data.avg_check.prev_n })}
                  </>
                : t("cat.avgCheckOpsOnly", { n: data.avg_check.n })}
            </div>
          </div>
        )}
        {data.year_ago && (
          <div className="card merchant-stat">
            <div className="label">
              {t("cat.yearAgo")}
              <InfoTip>{t("cat.yearAgoHint")}</InfoTip>
            </div>
            <div className="merchant-stat-v num-hero"><Money minor={data.year_ago.spent} decimals={false} /></div>
            <div className="merchant-stat-sub">
              {/* The trend chart above holds these very numbers; nobody can read one August
                  against another off a line with 24 points, which is why this is a figure. */}
              <DeltaChip a={total} b={data.year_ago.spent} goodUp={inc} />
            </div>
          </div>
        )}
        {data.budget && (
          <div className="card merchant-stat">
            <div className="label">{t("cat.budgetLabel")}</div>
            <div className="merchant-stat-v num-hero">
              <Money minor={data.budget.spent} decimals={false} /> / <Money minor={data.budget.amount} decimals={false} />
            </div>
            {/* The projection only when it says something the pair above does not — see EnvelopeGrid
                for why a lump carries no forecast worth showing. */}
            {!data.budget.lumpy && data.budget.projected > data.budget.amount && (
              <div className="merchant-stat-sub neg">
                {t("cat.budgetProjected", { pct: Math.round((data.budget.projected / data.budget.amount) * 100) })}
              </div>
            )}
          </div>
        )}
      </div>

      {/*
        §CAT-PAGE — "there is nothing in THIS window, but the category is not empty".
        This one line is the direct answer to the report: the window was genuinely empty, the page
        showed nothing, and nothing is exactly what a never-used category looks like. Now the page
        says which of the two it is, and offers the range that would show it.
      */}
      {emptyWindow && (
        <div className="card cat-empty-note">
          {t("cat.emptyWindow", { n: data.lifetime.n })}
          {range !== "all" && (
            <button className="cat-empty-cta" onClick={() => setRange("all")}>{t("cat.showAll")}</button>
          )}
        </div>
      )}

      {/* §CAT-PAGE — the whole history, so the page can be read without choosing a window at all. */}
      {data.lifetime.n > 0 && (
        <section>
          <div className="section-head"><h2>{t("cat.lifetimeTitle")}</h2></div>
          <div className="cat-life">
            <div className="card merchant-stat">
              <div className="label">{inc ? t("cat.lifeEarned") : t("cat.lifeSpent")}</div>
              <div className="merchant-stat-v num-hero"><Money minor={data.lifetime.total} decimals={false} /></div>
              <div className="merchant-stat-sub">{t("cat.lifeOps", { n: data.lifetime.n })}</div>
            </div>
            <div className="card merchant-stat">
              <div className="label">{t("cat.lifeFirst")}</div>
              <div className="merchant-stat-v num-hero" style={{ fontSize: 18 }}>
                {data.lifetime.first_at ? fmtDay.format(data.lifetime.first_at * 1000) : "—"}
              </div>
              <div className="merchant-stat-sub">
                {data.lifetime.last_at ? t("cat.lifeLast", { when: fmtDay.format(data.lifetime.last_at * 1000) }) : ""}
              </div>
            </div>
            <div className="card merchant-stat">
              <div className="label">{t("cat.perActiveMonth")}</div>
              <div className="merchant-stat-v num-hero"><Money minor={data.lifetime.per_active_month} decimals={false} /></div>
              <div className="merchant-stat-sub">{t("cat.levelMonths", { n: data.lifetime.active_months })}</div>
            </div>
          </div>
        </section>
      )}

      {/* Who this category actually IS — over the whole history, not the chosen window, so it
          stays informative on a page opened during a quiet month. */}
      {data.top_merchants.length > 0 && (
        <section>
          <div className="section-head">
            <h2>{t("cat.topMerchantsTitle")}</h2>
            <span className="label">
              {data.top_merchants[0] && data.top_merchants[0].share_pct >= 40
                // Concentration is only worth naming when there IS any: below this the honest
                // reading is "spread out", and a leading share of 11% dressed as a headline
                // would be the app manufacturing a finding.
                ? t("cat.topMerchantsConcentrated", { name: data.top_merchants[0].merchant, pct: data.top_merchants[0].share_pct })
                : t("cat.topMerchantsHint")}
            </span>
          </div>
          <div className="card">
            <ul className="cat-merch-list">
              {data.top_merchants.map((m) => (
                <li key={m.merchant}>
                  <Link className="cat-merch-name" to={`/merchant/${encodeURIComponent(m.merchant)}`}>{m.merchant}</Link>
                  {/* The share is what turns a list into an answer: a total tells the reader
                      nothing until they know what the category costs. */}
                  <span className="cat-merch-share label">{m.share_pct}%</span>
                  <span className="cat-merch-n label">{t("cat.merchantOps", { n: m.n })}</span>
                  <span className="num-mono">{formatMinor(Math.abs(m.spent), { decimals: false })} {baseSign()}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {/*
        §BUDGET-MEMORY — the question a budget could never answer before: not "how am I doing right
        now" but "am I getting better at this". The strip is deliberately NOT derived from the
        12-month trend above it: that is what was spent, while staying inside an envelope also
        depends on the limit in force at the time, and only these rows remember it.

        Rendered whenever the category HAS an envelope, empty state included — a section that
        appears out of nowhere in a month's time is a feature nobody knows to wait for.
      */}
      {data.budget && (
        <section>
          <div className="section-head">
            <h2>{t("cat.budgetHistory")}</h2>
            <span className="label">{t("cat.budgetHistoryHint")}</span>
          </div>
          <div className="card">
            {data.budget_history.length === 0
              ? <p className="label" style={{ margin: 0 }}>{t("cat.budgetHistoryEmpty")}</p>
              : (
                <ul className="bh-list">
                  {data.budget_history.map((m) => {
                    // The limit can be zero for a month the envelope carried no allowance into
                    // (a full overspend consumed it). Dividing by it would print Infinity%.
                    const ratio = m.limit > 0 ? m.spent / m.limit : (m.spent > 0 ? 1.5 : 0);
                    const over = m.spent > m.limit;
                    return (
                      <li key={m.month} className={`bh-row ${over ? "over" : "ok"}`}>
                        <span className="bh-month">{monthLabel(m.month)}</span>
                        <span className="bh-bar">
                          <i style={{ transform: `scaleX(${Math.min(ratio, 1)})` }} />
                          {/* Overspend gets its OWN mark past the end of the track rather than a
                              longer bar: a bar that can exceed its container stops being readable
                              as a proportion, which is the only thing this row is for. */}
                          {over && <b />}
                        </span>
                        <span className="bh-num">
                          <Money minor={m.spent} decimals={false} />
                          <span className="bh-of"> / <Money minor={m.limit} decimals={false} /></span>
                        </span>
                        <span className={`bh-verdict ${over ? "neg" : ""}`}>
                          {over ? t("cat.monthOver") : t("cat.monthWithin")}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
          </div>
        </section>
      )}

      <section>
        <div className="section-head"><h2>{t("cat.trendTitle")}</h2></div>
        <div className="card chart-card">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={chart} margin={{ left: Y_AXIS_LEFT_MARGIN, top: 8, right: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: "var(--muted)" }} axisLine={false} tickLine={false} />
              {/* Width auto: a hard-coded axis width clips the label the moment an amount gains a
                  digit, and a clipped number is indistinguishable from a real one. */}
              <YAxis {...Y_AXIS} tick={{ fontSize: 11, fill: "var(--muted)" }} axisLine={false} tickLine={false} />
              <Tooltip content={<CTooltip />} cursor={{ fill: "var(--surface-2)" }} />
              <Bar
                dataKey="spent" fill={data.color ?? "var(--accent)"} radius={[4, 4, 0, 0]} {...CHART_ANIM}
                cursor="pointer"
                // Toggle: the second click on the same bar closes it. A drill that can only be
                // opened leaves the page permanently taller than the reader asked for.
                // Recharts types the handler around its own mouse event; the datum rides on
                // `payload`, so it is read here rather than typed at the boundary.
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                onClick={(d: any) => {
                  const m = (d?.payload?.month ?? d?.month) as string | undefined;
                  setOpenMonth((cur) => (m && cur !== m ? m : null));
                }}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {openMonth && (
          <div className="card cat-month-drill">
            <div className="cat-month-head">
              <b>{monthLabel(openMonth)}</b>
              <span className="label">
                {monthLoading ? t("common.loading") : t("cat.monthOps", { n: monthRows?.length ?? 0 })}
              </span>
              <button className="cat-empty-cta" onClick={() => setOpenMonth(null)}>{t("cat.monthClose")}</button>
            </div>
            {/* Not gated on `monthLoading`: an empty list and a loading list must look different
                (CLAUDE.md — «вантажиться» і «даних справді нема» — різні екрани), and the header
                above already says which of the two this is. */}
            {!monthLoading && <TransactionList rows={monthRows ?? []} empty={t("cat.monthEmpty")} />}
          </div>
        )}
      </section>

      {/*
        «З чого складається» (2026-08-21). The chips that used to be here named the sub-categories
        and said nothing about them — so a parent page could not answer the only question a parent
        raises: «Транспорт виріс — це таксі чи пальне?». Every other figure on this page is the
        roll-up, which hides that by design.

        The parent's OWN rows are a part like any other, not a remainder: «74% цієї категорії лежить
        напряму» is a fact about how the ledger is kept, and it disappears in a list of children.
        Children with nothing in this window keep their chip below — navigation is why they were
        here, and a sub-category you cannot reach because it was quiet this month is the §CAT-PAGE
        bug in a smaller form.
      */}
      {/*
        §CAT-SUBS — «з них підписки». A subscription is not the category «Підписки»: internet sits
        under utilities, cloud under software. So the total above answers "how much" and hides "how
        much of it is fixed until I cancel something" — which is usually why the category was
        opened. Each row links to its own §SUB-PAGE, where that decision can actually be made.
      */}
      {data.subscriptions.items.length > 0 && (
        <section>
          <div className="section-head">
            <h2>{t("cat.subsTitle")}</h2>
            <span className="label">
              {data.subscriptions.share_pct != null
                ? t("cat.subsShare", { pct: data.subscriptions.share_pct })
                : t("cat.subsMonthly")}
            </span>
          </div>
          <div className="card sub-charge-list">
            {data.subscriptions.items.map((p) => (
              <Link key={p.id} className="sub-charge-row" to={`/subs/${p.id}`}>
                <span>{p.title}</span>
                <Money minor={p.monthly_base} decimals={false} />
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* A breakdown of ONE part is not a breakdown — it says «100% of this category is this
          category» and fills a card to say it. Below two parts the chips alone are the honest
          content of this section. */}
      {(data.composition.length > 1 || data.children.length > 0) && (
        <section>
          <div className="section-head">
            <h2>{data.composition.length > 1 ? t("cat.compositionTitle") : t("cat.childrenTitle")}</h2>
            <span className="label">
              {data.composition.length > 1 ? t("cat.compositionSub", { range: rangeLabel }) : t("cat.childrenSub")}
            </span>
          </div>
          {data.composition.length > 1 && (
            <div className="card">
              <ul className="cat-merch-list">
                {data.composition.map((p) => (
                  <li key={p.id}>
                    {p.self
                      ? <span className="cat-merch-name">{p.name}</span>
                      : <Link className="cat-merch-name" to={`/categories/${p.id}`}>{p.name}</Link>}
                    <span className="cat-merch-share label">{p.share_pct}%</span>
                    <span className="cat-merch-n label">
                      {p.self ? t("cat.compositionSelf") : t("cat.merchantOps", { n: p.n })}
                    </span>
                    <span className="num-mono">{formatMinor(p.spent, { decimals: false })} {baseSign()}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(() => {
            const shown = new Set(data.composition.length > 1 ? data.composition.map((p) => p.id) : []);
            const quiet = data.children.filter((ch) => !shown.has(ch.id));
            if (quiet.length === 0) return null;
            return (
              <div className="cat-page-children">
                {data.composition.length > 1 && <span className="label">{t("cat.compositionRest")}</span>}
                {quiet.map((ch) => (
                  <Link key={ch.id} className="cat-chip" to={`/categories/${ch.id}`}>
                    <span className="d" style={{ background: ch.color ?? "var(--muted)" }} />{ch.name}
                  </Link>
                ))}
              </div>
            );
          })()}
        </section>
      )}

      {!!drill?.merchants.length && (
        <section>
          <div className="section-head"><h2>{t("cat.merchantsTitle")}</h2></div>
          <div className="card">
            <ul className="cat-merch-list">
              {drill.merchants.slice(0, 12).map((m) => (
                <li key={m.merchant}>
                  <Link className="cat-merch-name" to={`/merchant/${encodeURIComponent(m.merchant)}`}>{m.merchant}</Link>
                  <span className="cat-merch-n label">{t("cat.merchantOps", { n: m.n })}</span>
                  <span className="num-mono">{formatMinor(Math.abs(m.spent), { decimals: false })} {baseSign()}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </>
  );
}
