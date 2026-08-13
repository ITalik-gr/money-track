import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { getLocale, localeTag } from "../../i18n/locale.ts";
import { useT, type TranslationKey } from "../../i18n/index.ts";
import { Icon } from "../ui/Icon.tsx";
import { Select } from "../ui/Select.tsx";
import { useGetAccountsQuery, useCsvPreviewMutation, useCsvCommitMutation } from "../../store/api.ts";
import { errText } from "../../lib/errors.ts";
import { formatMinor } from "../../lib/format.ts";
import { takeSharedStatement } from "../../lib/push.ts";

// Імпорт виписки з файлу (P1.2). Свідомо у ДВА кроки: спершу «ось що я зрозумів», і лише потім
// запис. Одноетапний імпорт означав би, що неправильно вгадану колонку суми видно вже після
// того, як місяць кривих чисел потрапив у канон — а вдруге ту саму виписку ніхто не перечитує.
type Mapping = { date?: number; amount?: number; description?: number; comment?: number | null; mcc?: number | null };

interface Preview {
  delimiter: string;
  headers: string[];
  sample: string[][];
  total_rows: number;
  mapping: Mapping;
  complete: boolean;
  parsed?: number;
  duplicates?: number;
  skipped?: { line: number; reason: string }[];
  skipped_total?: number;
  preview?: { time: number; amount: number; description: string | null }[];
  /** The currency the FILE names when it is not the account's. Amounts are stored as the ACCOUNT's. */
  currency_mismatch?: string | null;
  /** Rows above the table (bank details, the holder's identity, period totals) that were skipped. */
  preamble_rows?: number;
}

const FIELDS: { key: keyof Mapping; labelKey: TranslationKey; required: boolean }[] = [
  { key: "date", labelKey: "csv.fieldDate", required: true },
  { key: "amount", labelKey: "csv.fieldAmount", required: true },
  { key: "description", labelKey: "csv.fieldDescription", required: true },
  // MCC не обовʼязковий, але саме він вмикає детерміновану категоризацію (правила по MCC).
  { key: "mcc", labelKey: "csv.fieldMcc", required: false },
  { key: "comment", labelKey: "csv.fieldComment", required: false },
];

export function CsvImportCard() {
  const t = useT();
  const { data: accounts } = useGetAccountsQuery();
  const [preview, { isLoading: previewing }] = useCsvPreviewMutation();
  const [commit, { isLoading: committing }] = useCsvCommitMutation();

  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [accountId, setAccountId] = useState("");
  const [mapping, setMapping] = useState<Mapping>({});
  const [result, setPreviewResult] = useState<Preview | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setDone(null);
    // Читаємо на клієнті: файл виписки — це приватні дані, і немає причини гнати його
    // кудись двічі. Сервер отримає текст лише коли натиснуто «Розібрати».
    const content = await file.text();
    setText(content);
    setFileName(file.name);
    setPreviewResult(null);
    setMapping({});
  }

  /**
   * A statement shared into the app from the banking app's share sheet.
   *
   * Same mechanism as the receipt photo (`src/sw.ts`): a POST share target is delivered to the
   * service worker, never to the server, so the file is parked in a cache and the redirect lands
   * here with `?shared=statement`. It fills the SAME state the file picker fills — one path, so a
   * shared file cannot behave differently from a chosen one — and stops there: the account still
   * has to be picked and the preview still has to be read before anything is written.
   *
   * The marker is stripped from the URL first, or a reload would look like a second share.
   */
  // Arrived from the "statement is stale" notification: no file to pick up, just show the card.
  useEffect(() => {
    if (params.get("import") !== "1") return;
    setParams((p) => { p.delete("import"); return p; }, { replace: true });
    document.getElementById("csv-import")?.scrollIntoView({ behavior: "smooth", block: "start" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once for the link that opened this page
  }, []);

  useEffect(() => {
    if (params.get("shared") !== "statement") return;
    setParams((p) => { p.delete("shared"); return p; }, { replace: true });
    void takeSharedStatement().then(async (file) => {
      if (!file) return;
      setText(await file.text());
      setFileName(file.name);
      setPreviewResult(null);
      setMapping({});
      // Scrolled into view because the share opens the whole Settings page and this card is far
      // down it — landing on a page with no sign of the file you just shared reads as a failure.
      document.getElementById("csv-import")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once for the share that opened this page
  }, []);

  async function runPreview(nextMapping?: Mapping) {
    if (!text) return;
    setError(null);
    try {
      const res = await preview({
        text,
        account_id: accountId || undefined,
        mapping: nextMapping ?? mapping,
      }).unwrap();
      setPreviewResult(res);
      setMapping(res.mapping);
    } catch (e) {
      setError(errText(e));
    }
  }

  async function runCommit() {
    if (!text || !accountId) return;
    setError(null);
    try {
      const res = await commit({ text, account_id: accountId, mapping }).unwrap();
      setDone(
        t("csv.addedCount", { n: res.inserted }) +
          (res.duplicates ? t("csv.alreadyHadCount", { n: res.duplicates }) : "") +
          (res.skipped ? t("csv.skippedCount", { n: res.skipped }) : ""),
      );
      setPreviewResult(null);
      setText("");
      setFileName(null);
    } catch (e) {
      setError(errText(e));
    }
  }

  function setField(key: keyof Mapping, value: string) {
    const next = { ...mapping, [key]: value === "" ? null : Number(value) };
    setMapping(next);
    void runPreview(next);
  }

  const accountOptions = (accounts ?? []).map((a) => ({
    value: a.id,
    label: `${a.title ?? a.type ?? a.id}`,
  }));
  const canCommit = !!result?.complete && !!accountId && (result.parsed ?? 0) > 0;

  return (
    <div className="card set-card" id="csv-import">
      <div className="set-card-h"><Icon name="repeat" size={16} />{t("csv.title")}</div>
      <p className="set-card-sub">{t("csv.subtitle")}</p>
      {/*
        Said out loud because the alternative is finding out by failing: sharing a file INTO a web
        app needs the Web Share Target API, which exists on Android and has never existed on iOS —
        no browser there can offer it, Safari included. Naming the platform is the difference
        between "this app is broken" and "this is not a thing on iPhone".
      */}
      <p className="set-card-sub">{t("csv.shareHint")}</p>

      <div className="stack">
        <label className="btn" style={{ justifyContent: "center", cursor: "pointer" }}>
          {fileName ? t("csv.fileLabel", { name: fileName }) : t("csv.chooseFile")}
          <input type="file" accept=".csv,text/csv,text/plain" onChange={onFile} style={{ display: "none" }} />
        </label>

        {text && (
          <>
            <Select
              value={accountId}
              onChange={(v) => {
                setAccountId(String(v ?? ""));
                void runPreview();
              }}
              options={[{ value: "", label: t("csv.pickAccount") }, ...accountOptions]}
            />
            <button className="btn" onClick={() => runPreview()} disabled={previewing || !accountId}>
              {previewing ? "…" : t("csv.parseFile")}
            </button>
          </>
        )}

        {result && (
          <>
            {/* Мапінг показуємо ЗАВЖДИ, навіть коли вгадався: підтвердити колонку дешево,
                виявити помилку постфактум — ні. */}
            <div className="stack" style={{ gap: 8 }}>
              {FIELDS.map((f) => (
                <div key={f.key} className="row" style={{ gap: 8, alignItems: "center" }}>
                  <span className="muted" style={{ fontSize: 13, minWidth: 84 }}>
                    {t(f.labelKey)}{f.required ? " *" : ""}
                  </span>
                  <Select
                    value={mapping[f.key] == null ? "" : String(mapping[f.key])}
                    onChange={(v) => setField(f.key, v == null ? "" : String(v))}
                    options={[
                      { value: "", label: "—" },
                      ...result.headers.map((h, i) => ({ value: String(i), label: h || t("csv.columnFallback", { n: i + 1 }) })),
                    ]}
                  />
                </div>
              ))}
            </div>

            <div className="muted" style={{ fontSize: 13 }}>
              {t("csv.rowsInFile", { n: result.total_rows })}
              {result.complete && t("csv.parsedSuffix", { n: result.parsed ?? 0 })}
              {!!result.duplicates && t("csv.alreadyExistsSuffix", { n: result.duplicates })}
              {!!result.skipped_total && t("csv.skippedSuffix", { n: result.skipped_total })}
              {/* Said out loud: 23 rows silently disappearing is exactly the kind of thing this
                  screen exists to prevent, even when dropping them is correct. */}
              {!!result.preamble_rows && t("csv.preambleSuffix", { n: result.preamble_rows })}
            </div>

            {/*
              The file says one currency and the chosen account holds another. Not an error and
              not blocked — but the amounts will be stored as the account's currency, which is
              wrong by the exchange rate and looks entirely ordinary afterwards. This is the last
              screen where it can still be stopped.
            */}
            {!!result.currency_mismatch && (
              <div style={{ fontSize: 13, color: "var(--warn)" }}>
                {t("csv.currencyMismatch", { file: result.currency_mismatch })}
              </div>
            )}

            {result.complete && !!result.preview?.length && (
              <div className="stack" style={{ gap: 4 }}>
                {result.preview.map((r, i) => (
                  <div key={i} className="row" style={{ gap: 8, fontSize: 13, alignItems: "baseline" }}>
                    <span className="muted" style={{ minWidth: 76 }}>
                      {new Date(r.time * 1000).toLocaleDateString(localeTag(getLocale()))}
                    </span>
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.description ?? "—"}
                    </span>
                    <span className={r.amount < 0 ? "neg" : "pos"} style={{ fontVariantNumeric: "tabular-nums" }}>
                      {formatMinor(r.amount, { decimals: true })}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Пропущені рядки показуємо явно: тихо проковтнутий рядок — це зникла операція. */}
            {!!result.skipped?.length && (
              <details>
                <summary className="muted" style={{ fontSize: 13, cursor: "pointer" }}>
                  {t("csv.skippedRowsSummary", { n: result.skipped_total ?? 0 })}
                </summary>
                <ul className="muted" style={{ fontSize: 12, margin: "6px 0 0", paddingLeft: 18 }}>
                  {result.skipped.map((s) => (
                    <li key={s.line}>{t("csv.rowLine", { line: s.line, reason: s.reason })}</li>
                  ))}
                </ul>
              </details>
            )}

            <button className="btn primary" onClick={runCommit} disabled={!canCommit || committing}>
              {committing ? "…" : t("csv.importBtn", { n: result.parsed ?? 0 })}
            </button>
          </>
        )}

        {done && <p className="set-card-sub" style={{ marginBottom: 0 }}>{done}</p>}
        {error && <p className="neg" style={{ fontSize: 13, marginBottom: 0 }}>{error}</p>}
      </div>
    </div>
  );
}
