import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import { toast } from "../../lib/toast.ts";
import { errText } from "../../lib/errors.ts";
import {
  useGetSearchSettingsQuery, useSetSearchEnabledMutation, useIndexSearchBatchMutation,
} from "../../store/api.ts";

/**
 * §SEARCH-VEC — semantic search, and the switch that turns it on (docs/PERIMETER.md).
 *
 * ⚠️ The card says WHERE the text goes, in plain words, above the switch. Turning this on sends
 * the words of one's operations out of the Durable Object to be embedded — inside Cloudflare, to
 * no new third party, but out of it all the same. Somebody deciding that deserves the sentence
 * before the toggle, not in a doc they will never open.
 */
export function SearchCard() {
  const t = useT();
  const { data } = useGetSearchSettingsQuery();
  const [setEnabled, { isLoading: saving }] = useSetSearchEnabledMutation();
  const [indexBatch] = useIndexSearchBatchMutation();
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState<number | null>(null);

  const runBackfill = async () => {
    setBusy(true);
    try {
      // The client repeats while work remains — the same shape as the enrich and rate backfills.
      // A whole ledger in one request is a handler killed halfway with no record of how far it got.
      for (;;) {
        const r = await indexBatch().unwrap();
        setLeft(r.remaining);
        if (!r.remaining || !r.indexed) break;
      }
    } catch (e) { toast.error(errText(e)); }
    finally { setBusy(false); }
  };

  const remaining = left ?? data?.remaining ?? 0;

  return (
    <div className="card">
      <div className="section-head"><h3>{t("search.title")}</h3></div>
      <p className="fop-note">{t("search.note")}</p>

      <label className="fop-check">
        <input
          type="checkbox" role="switch" className="switch"
          checked={!!data?.enabled}
          disabled={saving}
          onChange={async (e) => {
            try { await setEnabled(e.target.checked).unwrap(); }
            catch (err) { toast.error(errText(err)); }
          }}
        />
        <span>{t("search.enable")}</span>
      </label>

      {data?.enabled && (
        <div className="fop-missing">
          <span>{remaining > 0 ? t("search.remaining", { n: String(remaining) }) : t("search.indexed")}</span>
          {remaining > 0 && (
            <button className="btn sm" disabled={busy} onClick={runBackfill}>{t("search.build")}</button>
          )}
        </div>
      )}
    </div>
  );
}
