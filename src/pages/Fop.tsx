import { useT } from "../i18n/index.ts";
import {
  useGetTaxStatusQuery, useGetTaxBusinessQuery, useUpdateTaxProfileMutation,
} from "../store/api.ts";
import { ErrorNote } from "../components/ui/ErrorNote.tsx";
import { SkeletonRows } from "../components/ui/Skeleton.tsx";
import { TaxHeader } from "../components/fop/TaxHeader.tsx";
import { TaxCalendar } from "../components/fop/TaxCalendar.tsx";
import { BusinessQuarters } from "../components/fop/BusinessQuarters.tsx";
import { QuarterOutlookCard } from "../components/fop/QuarterOutlookCard.tsx";
import { Counterparties } from "../components/fop/Counterparties.tsx";
import { BusinessCosts } from "../components/fop/BusinessCosts.tsx";
import { RegWatchCard } from "../components/fop/RegWatchCard.tsx";
import { TaxProfileCard } from "../components/fop/TaxProfileCard.tsx";

/**
 * `/fop` — the business, as its own screen (docs/TAX.md §0.1).
 *
 * A separate page rather than a card on `/plan` (owner, 2026-09-18: «ФОП це ж бізнес, окремий
 * організм»). The rest of the app answers questions about the PERSON — how much is mine, will it
 * last. This one answers questions about the BUSINESS: what it earned, who pays, what it costs,
 * what is left after tax, and what changed in the rules while you were working. None of those fit
 * in a list of personal envelopes.
 *
 * ⚠️ §TAX-UAH — every amount on this page is HRYVNIA, whatever base the rest of the app is
 * displaying. The state levies in hryvnia; a tax bill relabelled into dollars would be a figure
 * that appears on no document. So nothing here uses `baseSign()`, and the header says so once.
 *
 * The shell owns the two shared requests and hands them down, for the reason `Stats.tsx` keeps
 * its own: four blocks that fetched separately could disagree about one quarter, and the reader
 * would have no way to tell which card was stale.
 */
export function Fop() {
  const t = useT();
  const { data: status, isLoading: loadingStatus, error: statusError, refetch: refetchStatus } = useGetTaxStatusQuery();
  // The business figures are only meaningful once the module knows the group — before that every
  // quarter's tax would read as zero, which is a wrong number rather than a missing one.
  const { data: business, isLoading: loadingBusiness, error: businessError, refetch: refetchBusiness } =
    useGetTaxBusinessQuery(undefined, { skip: !status?.enabled });
  const [updateProfile, { isLoading: saving }] = useUpdateTaxProfileMutation();

  if (loadingStatus) return <SkeletonRows n={5} />;
  if (statusError) return <ErrorNote error={statusError} what={t("fop.title")} onRetry={refetchStatus} />;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="greet">{t("fop.title")}</div>
          <div className="sub">{t("fop.sub")}</div>
        </div>
      </div>

      {!status?.enabled ? (
        // The whole page in one card until the group is known. Guessing it would produce a
        // confidently wrong tax figure, which is the one kind of wrong here that carries a
        // penalty (docs/TAX.md §7).
        <TaxProfileCard profile={status?.profile} onSave={updateProfile} saving={saving} intro />
      ) : (
        <>
          <TaxHeader status={status} />
          <TaxCalendar status={status} />
          {loadingBusiness ? <SkeletonRows n={5} /> : businessError ? (
            <ErrorNote error={businessError} what={t("fop.business")} onRetry={refetchBusiness} />
          ) : business ? (
            <>
              <QuarterOutlookCard data={business} group={status.profile.group} />
              <BusinessQuarters data={business} />
              <Counterparties data={business} />
              <BusinessCosts data={business} />
            </>
          ) : null}
          {/* §TAX-FX — the income book, for the accountant. A plain link, not a fetch: the file
              is a GET, and letting the browser download it keeps the rate columns and the BOM
              intact without the client ever holding the CSV in memory. */}
          <div className="card fop-ledger">
            <div>
              <h3>{t("fop.ledger")}</h3>
              <p className="fop-note">{t("fop.ledgerNote")}</p>
            </div>
            <div className="row" style={{ gap: 6 }}>
              <a className="btn" href="/api/tax/ledger.csv" download>{t("fop.downloadLedger")}</a>
              {/* §TAX-DUE — the second thing an accountant asks for: not the rows, the quarters.
                  Read from the STORED obligations, so it reconciles with what was actually filed. */}
              <a className="btn ghost" href="/api/tax/summary.csv" download>{t("fop.downloadSummary")}</a>
            </div>
          </div>

          <RegWatchCard />
          <TaxProfileCard profile={status.profile} onSave={updateProfile} saving={saving} />
        </>
      )}
    </>
  );
}
