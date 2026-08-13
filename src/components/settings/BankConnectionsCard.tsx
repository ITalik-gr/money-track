// Linked banks and how they are DOING (BANKS.md §5, step 4).
//
// The card exists for one state above all: a sync that has been failing since Tuesday. Until now
// that produced a `console.error` in a log nobody reads, and the app looked exactly like an app
// whose owner spent nothing — the same defect as a cron report that fails silently.
import { useT } from "../../i18n/index.ts";
import { Icon } from "../ui/Icon.tsx";
import { EmptyCard } from "../ui/EmptyCard.tsx";
import { useGetConnectionsQuery, useSyncAccountsMutation } from "../../store/api.ts";
import { toast } from "../../lib/toast.ts";
import { errText } from "../../lib/errors.ts";
import { dateFmt } from "../../i18n/locale.ts";

/** Proper nouns, so not translated — the same reason `Accounts.tsx` keeps its own copy. */
const BANK_LABEL: Record<string, string> = { mono: "Monobank", privat: "PrivatBank" };

export function BankConnectionsCard() {
  const t = useT();
  const { data } = useGetConnectionsQuery();
  const [sync, syncState] = useSyncAccountsMutation();
  const connections = data?.connections ?? [];

  return (
    <div className="card set-card">
      <div className="set-card-h"><Icon name="repeat" size={16} />{t("conn.title")}</div>
      <p className="set-card-sub">{t("conn.subtitle")}</p>

      {/* A bank that has never been synced is not an error — it is the state every new account
          starts in, and saying so is the difference between "set this up" and "something broke". */}
      {!connections.length && <EmptyCard title={t("conn.empty")} hint={t("conn.emptyHint")} />}

      <div className="stack" style={{ gap: 0 }}>
        {connections.map((c) => (
          <div key={c.id} className="conn-row">
            {/* A status dot before the name: the state of a connection is the first thing this card
                exists to say, and it was previously buried in a sentence two lines down. */}
            <span className={`conn-dot ${c.last_error ? "bad" : c.last_sync_at ? "ok" : "idle"}`} />
            <div className="conn-top">
              {/* A provider id ("mono") is a database value, not a name. The label is only stored
                  once a sync has written the row, so the map covers everything before that. */}
              <span className="conn-name">{c.label ?? BANK_LABEL[c.provider] ?? c.provider}</span>
              <span className="conn-count">{t("conn.accounts", { n: c.accounts })}</span>
              {/* The action belongs ON the row it acts on. Sending someone to the first-run
                  checklist to press "run again" is asking them to find the button we could have
                  put here. Only for banks we can actually fetch from. */}
              {c.provider === "mono" && (
                <button
                  className="btn sm conn-sync"
                  disabled={syncState.isLoading}
                  onClick={async () => {
                    try { await sync().unwrap(); toast.success(t("conn.synced")); }
                    catch (e) { toast.error(errText(e)); }
                  }}
                >
                  {syncState.isLoading ? "…" : t("conn.syncNow")}
                </button>
              )}
            </div>
            <div className="conn-when">
              {c.last_sync_at
                ? t("conn.lastSync", { when: dateFmt({ dateStyle: "short", timeStyle: "short" }).format(c.last_sync_at * 1000) })
                : t("conn.neverSynced")}
            </div>
            {/*
              The error is shown WITH the last successful time above it, never instead of it:
              "worked at 09:00, failing since" and "never worked" call for different reactions,
              and a card that blanks the timestamp on failure cannot tell them apart.
            */}
            {!!c.last_error && (
              <div className="conn-error">{t("conn.failing", { error: c.last_error })}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
