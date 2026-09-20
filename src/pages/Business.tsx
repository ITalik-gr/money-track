import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useT, type TranslationKey } from "../i18n/index.ts";
import {
  useGetTaxStatusQuery, useGetTaxBusinessQuery, useUpdateTaxProfileMutation, useGetMeQuery,
} from "../store/api.ts";
import { ErrorNote } from "../components/ui/ErrorNote.tsx";
import { SkeletonRows } from "../components/ui/Skeleton.tsx";
import { EmptyCard } from "../components/ui/EmptyCard.tsx";
import { Icon } from "../components/ui/Icon.tsx";
import { TaxHeader } from "../components/fop/TaxHeader.tsx";
import { TaxCalendar } from "../components/fop/TaxCalendar.tsx";
import { BusinessQuarters } from "../components/fop/BusinessQuarters.tsx";
import { QuarterOutlookCard } from "../components/fop/QuarterOutlookCard.tsx";
import { BusinessCosts } from "../components/fop/BusinessCosts.tsx";
import { RegWatchCard } from "../components/fop/RegWatchCard.tsx";
import { BizOverview } from "../components/fop/BizOverview.tsx";
import { BizClients } from "../components/fop/BizClients.tsx";
import { BizSetup } from "../components/fop/BizSetup.tsx";
import { sampleBusiness, sampleStatus } from "../components/fop/sample.ts";

/**
 * `/business` — the business as its own organism (docs/TAX.md §0.1, §BIZ-SPLIT).
 *
 * A separate page rather than a card on `/plan`, for the reason it always was: the rest of the app
 * answers questions about the PERSON — how much is mine, will it last — and this one answers
 * questions about the BUSINESS. What changed on 2026-09-21 is the framing. The page WAS «ФОП», and
 * the tax module gated the whole screen; the owner's reading is the right one («це саме сторінка
 * бізнес… а фоп вже це як фіча просто додаткова»), so the business is the page and the tax is a
 * feature switched on inside it.
 *
 * ⚠️ TABS, and the shell owns the two shared requests — the same arrangement and the same reason
 * as `Stats.tsx`: five sections that each fetched their own quarter could disagree about one
 * quarter, and the reader would have no way to tell which card was stale.
 *
 * ⚠️ §TAX-UAH — every amount on this page is HRYVNIA whatever base the rest of the app displays.
 * The state levies in hryvnia; a tax bill relabelled into dollars appears on no document. So
 * nothing here uses `baseSign()`, and the tax tab says so once.
 */

const TABS = {
  overview: "fop.tab.overview",
  clients: "fop.tab.clients",
  costs: "fop.tab.costs",
  tax: "fop.tab.tax",
  setup: "fop.tab.setup",
} satisfies Record<string, TranslationKey>;
type TabKey = keyof typeof TABS;

/** Per-viewer, per-user (docs/UI.md — a global key showed a demo visitor the owner's state). */
const sampleKey = (userId: string | undefined) => `mt-biz-sample:${userId ?? "anon"}`;

function readSample(userId: string | undefined): boolean {
  try { return localStorage.getItem(sampleKey(userId)) === "1"; } catch { return false; }
}

export function Business() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const { data: me } = useGetMeQuery();
  const userId = me?.user?.id;

  const [sampleOn, setSampleOn] = useState(() => readSample(userId));
  const setSample = (on: boolean) => {
    setSampleOn(on);
    try { localStorage.setItem(sampleKey(userId), on ? "1" : "0"); } catch { /* private window */ }
  };

  const {
    data: realStatus, isLoading: loadingStatus, error: statusError, refetch: refetchStatus,
  } = useGetTaxStatusQuery(undefined, { skip: sampleOn });
  const [updateProfile, { isLoading: saving }] = useUpdateTaxProfileMutation();

  const status = sampleOn ? sampleStatus() : realStatus;
  const business = !!status?.profile.business;

  // The business figures are only meaningful once the module is on: before that every quarter
  // would read as zero income, which is a wrong number rather than a missing one.
  const {
    data: realBusiness, isLoading: loadingBusiness, error: businessError, refetch: refetchBusiness,
  } = useGetTaxBusinessQuery(undefined, { skip: sampleOn || !business });
  // `useMemo` because the fixture builds fresh objects: without it every render would hand the
  // charts a new array and re-animate them on any keystroke elsewhere on the page.
  const sampleData = useMemo(() => sampleBusiness(), []);
  const data = sampleOn ? sampleData : realBusiness;

  const tabParam = params.get("tab");
  const wanted: TabKey = tabParam && tabParam in TABS ? (tabParam as TabKey) : "overview";
  // A tab that cannot be shown must not leave the page blank: an old link to `?tab=tax` after the
  // tax module was switched off lands on the overview, not on nothing.
  const tab: TabKey = wanted === "tax" && !status?.enabled ? "overview" : !business ? "setup" : wanted;
  const setTab = (k: TabKey) => setParams((p) => {
    const next = new URLSearchParams(p); next.set("tab", k); return next;
  }, { replace: true });

  const visible = (Object.keys(TABS) as TabKey[])
    .filter((k) => (k === "tax" ? !!status?.enabled : true))
    .filter((k) => (k === "setup" || business));

  if (loadingStatus && !sampleOn) return <SkeletonRows n={5} />;
  if (statusError) return <ErrorNote error={statusError} what={t("biz.title")} onRetry={refetchStatus} />;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="greet">{t("biz.title")}</div>
          <div className="sub">{status?.enabled ? t("biz.subTax") : t("biz.sub")}</div>
        </div>
      </div>

      {/* Stated at the top of the page and never anywhere subtler: every number below is invented,
          and a figure about money that is mistaken for real is the one failure this mode can
          cause. It also carries its own way out, so the mode cannot be left on by accident. */}
      {sampleOn && (
        <div className="card biz-sample-banner">
          <Icon name="info" size={16} />
          <div>
            <b>{t("fop.sampleBanner")}</b>
            <p className="fop-note">{t("fop.sampleBannerNote")}</p>
          </div>
          <button className="btn sm" onClick={() => setSample(false)}>{t("fop.sampleOff")}</button>
        </div>
      )}

      <div className="stat-tabs" role="tablist">
        {visible.map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            className={`stat-tab ${tab === k ? "active" : ""}`}
            onClick={() => setTab(k)}
          >{t(TABS[k])}</button>
        ))}
      </div>

      <div className="biz-stack">
        {tab === "setup" && (
          <BizSetup
            profile={status?.profile}
            onSave={updateProfile}
            saving={saving}
            sample={sampleOn}
            onSample={setSample}
          />
        )}

        {tab !== "setup" && (
          loadingBusiness ? <SkeletonRows n={5} />
            : businessError ? <ErrorNote error={businessError} what={t("biz.title")} onRetry={refetchBusiness} />
              : !data || !status ? <EmptyCard icon="briefcase" title={t("fop.noData")} hint={t("fop.noDataHint")} />
                : (
                  <>
                    {tab === "overview" && <BizOverview data={data} status={status} />}
                    {tab === "clients" && <BizClients data={data} />}
                    {tab === "costs" && (
                      <>
                        <BusinessCosts data={data} />
                        <BusinessQuarters data={data} />
                      </>
                    )}
                    {tab === "tax" && (
                      <>
                        <TaxHeader status={status} />
                        <TaxCalendar status={status} />
                        <QuarterOutlookCard data={data} group={status.profile.group} />
                        {/* §TAX-FX — the income book, for the accountant. A plain link, not a
                            fetch: the file is a GET, and letting the browser download it keeps the
                            rate columns and the BOM intact without the client ever holding the CSV
                            in memory. */}
                        <div className="card fop-ledger">
                          <div>
                            <h3>{t("fop.ledger")}</h3>
                            <p className="fop-note">{t("fop.ledgerNote")}</p>
                          </div>
                          <div className="row" style={{ gap: 6 }}>
                            <a className="btn" href="/api/tax/ledger.csv" download>{t("fop.downloadLedger")}</a>
                            {/* The second thing an accountant asks for: not the rows, the
                                quarters. Read from the STORED obligations, so it reconciles with
                                what was actually filed (§TAX-DUE). */}
                            <a className="btn ghost" href="/api/tax/summary.csv" download>{t("fop.downloadSummary")}</a>
                          </div>
                        </div>
                        <RegWatchCard />
                      </>
                    )}
                  </>
                )
        )}
      </div>
    </>
  );
}
