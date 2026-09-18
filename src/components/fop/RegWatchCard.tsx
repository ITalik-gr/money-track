import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import { Icon } from "../ui/Icon.tsx";
import { toast } from "../../lib/toast.ts";
import { errText } from "../../lib/errors.ts";
import {
  useGetRegWatchQuery, useCheckRegSourcesMutation, useAddRegSourceMutation,
  useUnmuteRegSourceMutation, useRemoveRegSourceMutation, useSaveRequisiteMutation,
} from "../../store/api.ts";
import { ErrorNote } from "../ui/ErrorNote.tsx";

const KINDS = ["single_tax", "military_levy", "social_contribution"] as const;

function ago(unix: number | null, never: string): string {
  if (!unix) return never;
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

/**
 * §TAX-WATCH — the card that exists because of one story: a ФОП's payment requisites changed,
 * nobody told him, and the money went to the old account.
 *
 * ⚠️ THE RULE THIS COMPONENT ENFORCES: the app shows a LINK and a DATE, never a requisite it
 * obtained itself. The IBAN fields below are inputs — a human types them and presses «checked».
 * The app's only claim is «this page changed after the date you checked», which it can prove from
 * two stored timestamps. Nothing here is ever populated from a fetch or from a model, because the
 * value being handled is the string other people's money travels along, and a confident near-miss
 * causes exactly the loss this card exists to prevent.
 */
export function RegWatchCard() {
  const t = useT();
  const { data, isLoading, error, refetch } = useGetRegWatchQuery();
  const [check, { isLoading: checking }] = useCheckRegSourcesMutation();
  const [addSource] = useAddRegSourceMutation();
  const [unmute] = useUnmuteRegSourceMutation();
  const [removeSource] = useRemoveRegSourceMutation();
  const [save] = useSaveRequisiteMutation();
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ iban: string; recipient: string; edrpou: string; purpose: string }>(
    { iban: "", recipient: "", edrpou: "", purpose: "" },
  );

  if (isLoading) return null;
  if (error) return <ErrorNote error={error} what={t("fop.watch")} onRetry={refetch} />;

  const byKind = new Map((data?.requisites ?? []).map((r) => [r.kind, r]));
  const staleCount = (data?.requisites ?? []).filter((r) => r.stale).length;

  return (
    <div className="card">
      <div className="section-head">
        <h3>{t("fop.watch")}</h3>
        <button className="btn sm" disabled={checking} onClick={async () => {
          try {
            const res = await check().unwrap();
            const changed = res.results.filter((r) => r.changed).length;
            const failed = res.results.filter((r) => r.error).length;
            // Failures are reported, not swallowed: a watch that silently checks nothing keeps
            // answering «no changes» forever, which is worse than having no watch at all.
            const msg = failed
              ? t("fop.checkedWithErrors", { n: String(changed), failed: String(failed) })
              : t("fop.checked", { n: String(changed) });
            if (failed) toast.error(msg); else toast.info(msg);
          } catch (e) { toast.error(errText(e)); }
        }}>{t("fop.checkNow")}</button>
      </div>

      <p className="fop-note">{t("fop.watchNote")}</p>
      {staleCount > 0 && <div className="fop-stale-banner">{t("fop.staleBanner", { n: String(staleCount) })}</div>}

      <div className="fop-req">
        {KINDS.map((kind) => {
          const r = byKind.get(kind);
          const editing = open === kind;
          return (
            <div key={kind} className={`fop-req-row ${r?.stale ? "stale" : ""}`}>
              <div className="fop-req-head">
                <span className="fop-req-kind">{t(`fop.kind.${kind}` as never)}</span>
                <span className="fop-req-iban">{r?.iban || t("fop.noIban")}</span>
                <button className="btn sm" onClick={() => {
                  setOpen(editing ? null : kind);
                  setDraft({
                    iban: r?.iban ?? "", recipient: r?.recipient ?? "",
                    edrpou: r?.edrpou ?? "", purpose: r?.purpose ?? "",
                  });
                }}>{editing ? t("common.cancel") : t("fop.edit")}</button>
              </div>

              {/* Two different sentences, deliberately not merged: «you have never checked this»
                  is not a warning about a change, and showing it as one would make it unfixable
                  — confirming would clear an alarm that was never about confirmation. */}
              <div className="fop-req-state">
                {r?.stale
                  ? <span className="fop-warn">{t("fop.sourceMoved", { date: ago(r.source_changed_at, "—"), checked: ago(r.verified_at, "—") })}</span>
                  : r?.verified_at
                    ? <span className="fop-ok">{t("fop.verifiedOn", { date: ago(r.verified_at, "—") })}</span>
                    : <span className="fop-muted">{t("fop.neverVerified")}</span>}
              </div>

              {editing && (
                <div className="fop-req-form">
                  <input placeholder="IBAN" value={draft.iban} onChange={(e) => setDraft({ ...draft, iban: e.target.value })} />
                  <input placeholder={t("fop.recipient")} value={draft.recipient} onChange={(e) => setDraft({ ...draft, recipient: e.target.value })} />
                  <input placeholder={t("fop.edrpou")} value={draft.edrpou} onChange={(e) => setDraft({ ...draft, edrpou: e.target.value })} />
                  <input placeholder={t("fop.purpose")} value={draft.purpose} onChange={(e) => setDraft({ ...draft, purpose: e.target.value })} />
                  <button className="btn primary sm" onClick={async () => {
                    try {
                      // `verified: true` is a HUMAN act — «I have just looked at the source and
                      // this is right». No code path that fetched anything ever sets it, which is
                      // what makes «changed since you checked» mean something.
                      await save({ kind, ...draft, verified: true }).unwrap();
                      setOpen(null);
                    } catch (e) { toast.error(errText(e)); }
                  }}>{t("fop.saveVerified")}</button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="fop-sources">
        <h4>{t("fop.sources")}</h4>
        {(data?.sources ?? []).map((s) => (
          <div key={s.id} className={`fop-source ${s.noisy ? "noisy" : ""}`}>
            <a href={s.url} target="_blank" rel="noreferrer noopener">{s.label}</a>
            <span className="fop-source-when">
              {s.last_changed ? t("fop.changedOn", { date: ago(s.last_changed, "—") }) : t("fop.noChangeYet")}
              {s.last_checked && ` · ${t("fop.checkedOn", { date: ago(s.last_checked, "—") })}`}
            </span>
            {s.last_error && <span className="fop-warn">{s.last_error}</span>}
            {/* A page with a banner or a counter changes its hash daily. It keeps recording and
                stops speaking until a person decides it is worth watching again — an alert that
                arrives every day is one nobody reads, and then the real change goes out with it. */}
            {!!s.noisy && (
              <button className="btn sm" onClick={() => unmute(s.id)}>{t("fop.unmute")}</button>
            )}
            <button className="btn sm ghost" onClick={() => removeSource(s.id)} aria-label={t("common.delete")}>
              <Icon name="trash" size={14} />
            </button>
          </div>
        ))}

        <div className="fop-add-source">
          <input placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
          <input placeholder={t("fop.sourceLabel")} value={label} onChange={(e) => setLabel(e.target.value)} />
          <button className="btn sm" onClick={async () => {
            try {
              await addSource({ url: url.trim(), label: label.trim() || url.trim(), topic: "requisites" }).unwrap();
              setUrl(""); setLabel("");
            } catch (e) { toast.error(errText(e)); }
          }}>{t("fop.addSource")}</button>
        </div>
        {/* Every ФОП pays into their OWN community's accounts, so the national seeds are a
            starting point and never an authority. Said here rather than assumed. */}
        <p className="fop-note">{t("fop.sourcesNote")}</p>
      </div>
    </div>
  );
}
