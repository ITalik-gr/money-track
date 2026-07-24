import { useState } from "react";
import { Icon } from "./Icon.tsx";
import { Select } from "./Select.tsx";
import { useGetAccountsQuery, useCsvPreviewMutation, useCsvCommitMutation } from "../store/api.ts";
import { errText } from "../lib/errors.ts";
import { formatMinor } from "../lib/format.ts";

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
}

const FIELDS: { key: keyof Mapping; label: string; required: boolean }[] = [
  { key: "date", label: "Дата", required: true },
  { key: "amount", label: "Сума", required: true },
  { key: "description", label: "Опис", required: true },
  // MCC не обовʼязковий, але саме він вмикає детерміновану категоризацію (правила по MCC).
  { key: "mcc", label: "MCC", required: false },
  { key: "comment", label: "Коментар", required: false },
];

export function CsvImportCard() {
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
        `Додано ${res.inserted}` +
          (res.duplicates ? `, вже було ${res.duplicates}` : "") +
          (res.skipped ? `, пропущено ${res.skipped}` : ""),
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
    <div className="card set-card">
      <div className="set-card-h"><Icon name="repeat" size={16} />Імпорт виписки (CSV)</div>
      <p className="set-card-sub">
        Будь-який банк, який уміє експортувати виписку. Повторний імпорт того самого періоду
        не дублює операції.
      </p>

      <div className="stack">
        <label className="btn" style={{ justifyContent: "center", cursor: "pointer" }}>
          {fileName ? `Файл: ${fileName}` : "Обрати файл…"}
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
              options={[{ value: "", label: "На який рахунок…" }, ...accountOptions]}
            />
            <button className="btn" onClick={() => runPreview()} disabled={previewing || !accountId}>
              {previewing ? "…" : "Розібрати файл"}
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
                    {f.label}{f.required ? " *" : ""}
                  </span>
                  <Select
                    value={mapping[f.key] == null ? "" : String(mapping[f.key])}
                    onChange={(v) => setField(f.key, v == null ? "" : String(v))}
                    options={[
                      { value: "", label: "—" },
                      ...result.headers.map((h, i) => ({ value: String(i), label: h || `колонка ${i + 1}` })),
                    ]}
                  />
                </div>
              ))}
            </div>

            <div className="muted" style={{ fontSize: 13 }}>
              Рядків у файлі: {result.total_rows}
              {result.complete && ` · розібрано ${result.parsed}`}
              {!!result.duplicates && ` · вже є ${result.duplicates}`}
              {!!result.skipped_total && ` · пропущено ${result.skipped_total}`}
            </div>

            {result.complete && !!result.preview?.length && (
              <div className="stack" style={{ gap: 4 }}>
                {result.preview.map((r, i) => (
                  <div key={i} className="row" style={{ gap: 8, fontSize: 13, alignItems: "baseline" }}>
                    <span className="muted" style={{ minWidth: 76 }}>
                      {new Date(r.time * 1000).toLocaleDateString("uk-UA")}
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
                  Пропущені рядки ({result.skipped_total})
                </summary>
                <ul className="muted" style={{ fontSize: 12, margin: "6px 0 0", paddingLeft: 18 }}>
                  {result.skipped.map((s) => (
                    <li key={s.line}>рядок {s.line}: {s.reason}</li>
                  ))}
                </ul>
              </details>
            )}

            <button className="btn primary" onClick={runCommit} disabled={!canCommit || committing}>
              {committing ? "…" : `Імпортувати ${result.parsed ?? 0} операцій`}
            </button>
          </>
        )}

        {done && <p className="set-card-sub" style={{ marginBottom: 0 }}>{done}</p>}
        {error && <p className="neg" style={{ fontSize: 13, marginBottom: 0 }}>{error}</p>}
      </div>
    </div>
  );
}
