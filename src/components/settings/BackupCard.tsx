import { useRef, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { dateFmt } from "../../i18n/locale.ts";
import { toast } from "../../lib/toast.ts";
import { errText } from "../../lib/errors.ts";
import { Icon } from "../ui/Icon.tsx";
import { ErrorNote } from "../ui/ErrorNote.tsx";
import {
  useGetBackupsQuery, useRunBackupMutation, useDeleteBackupMutation, useRestoreBackupMutation,
  type RestoreResult,
} from "../../store/api.ts";

const when = dateFmt({ day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const kb = (n: number) => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/**
 * Automatic copies of this account's data, kept in R2.
 *
 * Until now there were none — everything lived in exactly one Durable Object and the only second
 * copy was a file the user had thought to download in advance. This card is the visible half of
 * that fix; the invisible half is a nightly job.
 *
 * ⚠️ Restore asks the user to TYPE the word, like erasure does, and for the same reason: it
 * replaces every row in the account, and the only thing standing between a stray click and a
 * fortnight-old database should not be a button's position on screen.
 */
export function BackupCard() {
  const t = useT();
  const { data, isError, error, refetch } = useGetBackupsQuery();
  const [run, runState] = useRunBackupMutation();
  const [remove] = useDeleteBackupMutation();
  const [restore, restoreState] = useRestoreBackupMutation();
  const [confirmFor, setConfirmFor] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [report, setReport] = useState<RestoreResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function doRestore(arg: { name?: string; file?: string }) {
    try {
      const r = await restore(arg).unwrap();
      setReport(r);
      setConfirmFor(null);
      setTyped("");
      toast.success(t("backup.restored"));
    } catch (e) {
      toast.error(errText(e));
    }
  }

  async function onFile(f: File) {
    // Read on the CLIENT and post the text: the file is the user's own dump, and a multipart
    // upload would need a second parser on the server for no gain.
    try {
      await doRestore({ file: await f.text() });
    } catch (e) {
      toast.error(errText(e));
    }
  }

  const list = data?.backups ?? [];

  return (
    <div className="card set-card">
      <div className="set-card-h"><Icon name="export" size={16} />{t("backup.title")}</div>
      <p className="set-card-sub">{t("backup.sub", { n: data?.keep ?? 14 })}</p>

      {isError && <ErrorNote error={error} what={t("backup.title")} onRetry={refetch} />}

      <div className="stack" style={{ marginBottom: 12 }}>
        <button className="btn" disabled={runState.isLoading} onClick={async () => {
          try { const r = await run().unwrap(); toast.success(t("backup.madeNow", { size: kb(r.size) })); }
          catch (e) { toast.error(errText(e)); }
        }}>
          {runState.isLoading ? t("backup.running") : t("backup.runNow")}
        </button>
      </div>

      {!isError && list.length === 0 && (
        // "Ще не було" і "не вдалося прочитати" — різні екрани: перший нормальний для акаунта,
        // створеного сьогодні, другий означає, що бекапів може не бути й завтра.
        <div className="muted" style={{ fontSize: 12.5 }}>{t("backup.empty")}</div>
      )}

      <div className="bk-list">
        {list.map((b) => (
          <div key={b.name} className={`bk-row ${b.name.startsWith("pre-restore") ? "safety" : ""}`}>
            <span className="bk-when">
              {when.format(new Date(b.created_at * 1000))}
              {b.name.startsWith("pre-restore") && <span className="bk-tag">{t("backup.safetyCopy")}</span>}
            </span>
            <span className="bk-size">{kb(b.size)}</span>
            <a className="bk-act" href={`/api/backups/${encodeURIComponent(b.name)}`} download>{t("backup.download")}</a>
            <button className="bk-act" onClick={() => { setConfirmFor(b.name); setTyped(""); }}>{t("backup.restore")}</button>
            <button className="bk-act danger" onClick={async () => {
              try { await remove(b.name).unwrap(); } catch (e) { toast.error(errText(e)); }
            }}>{t("common.delete")}</button>
          </div>
        ))}
      </div>

      {confirmFor && (
        <div className="bk-confirm">
          <div className="bk-warn">{t("backup.confirmWarn")}</div>
          <input
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="RESTORE"
            aria-label={t("backup.confirmWarn")}
          />
          <div className="row" style={{ gap: 8 }}>
            <button className="btn danger" disabled={typed !== "RESTORE" || restoreState.isLoading}
              onClick={() => void doRestore({ name: confirmFor })}>
              {restoreState.isLoading ? t("backup.restoring") : t("backup.restoreConfirm")}
            </button>
            <button className="btn ghost" onClick={() => { setConfirmFor(null); setTyped(""); }}>{t("common.cancel")}</button>
          </div>
        </div>
      )}

      {/* Відновлення з ФАЙЛУ — окремий шлях, бо він єдиний працює, коли обʼєкта вже нема:
          завантажений колись `money-track-*.json` не залежить від того, що лишилось у R2. */}
      <div className="bk-upload">
        <input ref={fileRef} type="file" accept="application/json,.json" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ""; }} />
        <button className="btn ghost sm" onClick={() => fileRef.current?.click()}>{t("backup.fromFile")}</button>
      </div>

      {report && (
        <div className="bk-report">
          <div>{t("backup.reportRows", { n: Object.values(report.restored).reduce((s, n) => s + n, 0) })}</div>
          {/* Пропущене НЕ ховаємо: бекап зі старішої схеми відновлюється, але мовчазне
              «готово» приховало б, що частина файлу нікуди не лягла. */}
          {report.skipped_tables.length > 0 && (
            <div className="muted">{t("backup.reportSkipped", { list: report.skipped_tables.join(", ") })}</div>
          )}
          {report.dropped_columns.length > 0 && (
            <div className="muted">{t("backup.reportDropped", { list: report.dropped_columns.join(", ") })}</div>
          )}
        </div>
      )}
    </div>
  );
}
