import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { takeSharedReceipt } from "../lib/push.ts";
import { getLocale, localeTag } from "../i18n/locale.ts";
import { useDispatch } from "react-redux";
import {
  api, useAddTransactionMutation, useAddTransferMutation, useGetAccountsQuery,
  useGetCategoriesQuery, useGetCredentialsQuery, useGetFrequentTxQuery,
} from "../store/api.ts";
import { toast } from "../lib/toast.ts";
import { errText } from "../lib/errors.ts";
import { useT } from "../i18n/index.ts";
import { Icon } from "../components/ui/Icon.tsx";
import { Select } from "../components/ui/Select.tsx";
import { Money } from "../components/ui/Money.tsx";

/**
 * "Add an operation".
 *
 * Rewritten 2026-07-31, and the reason is open sign-up: the page used to be nothing but an AI
 * text parser and a receipt photo, so a brand-new account without an Anthropic key could not
 * record a single transaction by hand. The AI is a shortcut, not the only door.
 *
 * Three modes rather than one form with a sign toggle buried in it: an expense, an income and a
 * transfer are different operations with different fields (a transfer has no category and two
 * accounts). Income was outright impossible before — `save()` hard-coded a minus.
 */
type Mode = "expense" | "income" | "transfer";

interface ParsedText {
  merchant: string;
  amount: number; // major units
  currency: string;
  category_guess: number | null;
  note: string | null;
}

interface ReceiptItem { name: string; qty: number; price: number }
interface ReceiptResult {
  store: string;
  purchased_at: string | null;
  currency: string;
  total: number; // major units
  items: ReceiptItem[];
}
interface ReceiptResponse {
  ok?: boolean;
  receiptId?: number;
  transactionId?: string | null;
  matched?: boolean;
  result?: ReceiptResult;
  error?: string;
}

const CURRENCIES = [
  { value: 980, label: "₴ UAH" },
  { value: 840, label: "$ USD" },
  { value: 978, label: "€ EUR" },
];
const currencyCode = (c: string): number => (c === "USD" ? 840 : c === "EUR" ? 978 : 980);
const fmtMoney = (major: number, cur: string): string =>
  `${major.toLocaleString(localeTag(getLocale()), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}`;

/** `YYYY-MM-DD` of the LOCAL day — `toISOString()` hands back yesterday late in the evening. */
function todayIso(): string {
  return new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
/** Date input value → unix. Keeps the current time of day, so today's entries stay in order. */
function isoToUnix(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  const now = new Date();
  return Math.floor(new Date(y, m - 1, d, now.getHours(), now.getMinutes(), now.getSeconds()).getTime() / 1000);
}

const num = (s: string): number => Number(s.replace(",", "."));

export function Add() {
  const t = useT();
  const { data: accounts } = useGetAccountsQuery();
  const { data: cats } = useGetCategoriesQuery();
  const { data: creds } = useGetCredentialsQuery();
  const { data: frequent } = useGetFrequentTxQuery();
  const [addTx, { isLoading: saving }] = useAddTransactionMutation();
  const [addTransfer, { isLoading: transferring }] = useAddTransferMutation();
  const dispatch = useDispatch();

  const [mode, setMode] = useState<Mode>("expense");
  const [amount, setAmount] = useState("");
  const [merchant, setMerchant] = useState("");
  const [currency, setCurrency] = useState(980);
  const [category, setCategory] = useState<number | null>(null);
  const [account, setAccount] = useState("");      // "" = cash
  const [fromAcc, setFromAcc] = useState("");
  const [toAcc, setToAcc] = useState("");
  const [toAmount, setToAmount] = useState("");
  const [date, setDate] = useState(todayIso());
  const [note, setNote] = useState("");

  // `available` (a usable key exists anywhere) rather than `set` (the user stored their own):
  // the owner runs on deployment secrets and has no row. Name is lower-case in the API.
  const hasAiKey = creds?.secrets.find((s) => s.name === "anthropic_api_key")?.available === true;

  // Parents first, sub-categories indented under them (the shape used everywhere else). Income
  // and expense taxonomies are disjoint, so the mode picks the half — offering "Продукти" as an
  // income category is how a wrong number ends up in the canon.
  const catOptions = useMemo(() => {
    const list = (cats ?? []).filter((c) => (mode === "income" ? !!c.is_income : !c.is_income));
    const out: { value: number; label: string; color?: string | null; icon?: string | null; indent?: boolean }[] = [];
    for (const p of list.filter((c) => c.parent_id == null)) {
      out.push({ value: p.id, label: p.name, color: p.color, icon: p.icon });
      for (const ch of list.filter((c) => c.parent_id === p.id)) {
        out.push({ value: ch.id, label: ch.name, color: ch.color ?? p.color, icon: ch.icon, indent: true });
      }
    }
    return out;
  }, [cats, mode]);

  // `title` is nullable in the API type (a bank account can arrive unnamed); fall back to the id
  // rather than rendering an empty row the user cannot tell apart from the next one.
  const accOptions = useMemo(
    () => (accounts ?? []).map((a) => ({ value: a.id, label: a.title ?? a.id.slice(0, 8) })),
    [accounts],
  );
  const accCurrency = (id: string) => (accounts ?? []).find((a) => a.id === id)?.currency_code ?? 980;
  const crossCurrency = !!fromAcc && !!toAcc && accCurrency(fromAcc) !== accCurrency(toAcc);

  const amountMinor = Math.round(num(amount) * 100);
  const canSave = Number.isFinite(amountMinor) && amountMinor > 0;
  const canTransfer = !!fromAcc && !!toAcc && fromAcc !== toAcc && canSave
    && (!crossCurrency || num(toAmount) > 0);

  function resetForm() {
    setAmount(""); setMerchant(""); setNote(""); setToAmount(""); setDate(todayIso());
  }

  async function saveManual() {
    if (!canSave) return;
    const onCard = account !== "";
    try {
      await addTx({
        account_id: onCard ? account : undefined,
        // Cash routes to the dedicated cash account (created on demand by the backend); an
        // explicitly picked card is a manual entry ON that card.
        source: onCard ? "manual" : "cash",
        amount: mode === "income" ? amountMinor : -amountMinor,
        currency_code: onCard ? accCurrency(account) : currency,
        merchant: merchant.trim() || null,
        category_id: category,
        user_note: note.trim() || null,
        time: isoToUnix(date),
      }).unwrap();
      toast.success(t(mode === "income" ? "add.toastIncomeSaved" : "add.toastSaved", {
        name: merchant.trim() || t("add.noName"),
      }));
      resetForm();
    } catch (e) { toast.error(errText(e)); }
  }

  async function saveTransfer() {
    if (!canTransfer) return;
    try {
      await addTransfer({
        from_account_id: fromAcc,
        to_account_id: toAcc,
        amount: amountMinor,
        to_amount: crossCurrency ? Math.round(num(toAmount) * 100) : undefined,
        time: isoToUnix(date),
        user_note: note.trim() || undefined,
      }).unwrap();
      toast.success(t("add.toastTransferSaved"));
      resetForm();
    } catch (e) { toast.error(errText(e)); }
  }

  /** One-tap repeat FILLS the form rather than saving straight away: a mis-tap that silently
   *  writes a transaction is worse than one extra tap, and the amount usually needs a nudge. */
  function applyFrequent(f: { merchant: string; amount: number; category_id: number | null; currency_code: number }) {
    setMode("expense");
    setMerchant(f.merchant);
    setAmount(String(f.amount / 100));
    setCategory(f.category_id);
    setCurrency(f.currency_code);
    setAccount("");
  }

  const submit = () => (mode === "transfer" ? saveTransfer() : saveManual());

  return (
    <>
      <div className="page-head">
        <div>
          <div className="greet">{t("add.title")}</div>
          <div className="sub">{t("add.subtitle")}</div>
        </div>
      </div>

      <div className="stat-tabs" role="tablist">
        {(["expense", "income", "transfer"] as Mode[]).map((m) => (
          <button key={m} role="tab" aria-selected={mode === m}
            className={`stat-tab ${mode === m ? "active" : ""}`} onClick={() => setMode(m)}>
            {t(m === "expense" ? "add.modeExpense" : m === "income" ? "add.modeIncome" : "add.modeTransfer")}
          </button>
        ))}
      </div>

      <div className="add-grid">
        <div className="stack" style={{ gap: 16 }}>
          <div className="card add-form">
            {/* Amount is the hero: the one field entered every single time, and the only one that
                cannot be empty. Everything else is optional refinement. */}
            <label className="add-amount">
              <span className="label">{t("add.amountLabel")}</span>
              <div className="add-amount-row">
                <input
                  className={`add-amount-input ${mode === "income" ? "pos" : ""}`}
                  type="text" inputMode="decimal" placeholder="0" autoFocus
                  value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, ""))}
                  onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
                />
                {mode !== "transfer" && account === "" && (
                  <Select value={currency} options={CURRENCIES} onChange={(v) => setCurrency(Number(v))} />
                )}
              </div>
            </label>

            {mode === "transfer" ? (
              <>
                <Field label={t("add.fromAccount")}>
                  <Select value={fromAcc || null} options={accOptions} placeholder={t("add.pickAccount")}
                    onChange={(v) => setFromAcc(v == null ? "" : String(v))} />
                </Field>
                <Field label={t("add.toAccount")}>
                  <Select value={toAcc || null} options={accOptions.filter((o) => o.value !== fromAcc)}
                    placeholder={t("add.pickAccount")} onChange={(v) => setToAcc(v == null ? "" : String(v))} />
                </Field>
                {/* Cross-currency asks for the second number instead of converting: applying
                    today's rate would invent an exchange rate the user never actually got. */}
                {crossCurrency && (
                  <Field label={t("add.arrivedAmount")}>
                    <input type="text" inputMode="decimal" value={toAmount}
                      onChange={(e) => setToAmount(e.target.value.replace(/[^\d.,]/g, ""))} />
                  </Field>
                )}
              </>
            ) : (
              <>
                <Field label={mode === "income" ? t("add.sourceLabel") : t("add.merchantLabel")}>
                  <input value={merchant} onChange={(e) => setMerchant(e.target.value)}
                    placeholder={mode === "income" ? t("add.sourcePlaceholder") : t("add.merchantPlaceholder")} />
                </Field>
                <Field label={t("tx.label.category")}>
                  <Select value={category} options={catOptions} clearable placeholder={t("add.noCategory")}
                    onChange={(v) => setCategory(v == null ? null : Number(v))} />
                </Field>
                <Field label={t("add.accountLabel")}>
                  <Select value={account || null} options={accOptions} clearable
                    clearLabel={t("add.cashOption")} placeholder={t("add.cashOption")}
                    onChange={(v) => setAccount(v == null ? "" : String(v))} />
                </Field>
              </>
            )}

            <Field label={t("add.dateLabel")}>
              <input type="date" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label={t("add.noteLabel")}>
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("add.notePlaceholder")} />
            </Field>

            <button className="btn primary lg" style={{ marginTop: 4 }}
              disabled={mode === "transfer" ? !canTransfer || transferring : !canSave || saving}
              onClick={submit}>
              {saving || transferring ? t("add.savingBtn")
                : mode === "transfer" ? t("add.saveTransferBtn")
                  : mode === "income" ? t("add.saveIncomeBtn") : t("add.saveExpenseBtn")}
            </button>
          </div>

          {/* Repeats sit UNDER the form: they are a shortcut for regulars, and a new account has
              none — an empty block at the top would read as something broken. */}
          {mode === "expense" && (frequent ?? []).length > 0 && (
            <div className="card">
              <div className="section-head" style={{ marginTop: 0 }}>
                <h2>{t("add.frequentTitle")}</h2>
                <span className="label">{t("add.frequentHint")}</span>
              </div>
              <div className="add-chips">
                {(frequent ?? []).map((f) => (
                  <button key={`${f.merchant}-${f.currency_code}`} className="add-chip" onClick={() => applyFrequent(f)}>
                    <span className="ac-name">{f.merchant}</span>
                    <span className="ac-amt"><Money minor={f.amount} currency={f.currency_code} decimals={false} /></span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <AiPanel hasAiKey={hasAiKey} accounts={accOptions} cats={cats ?? []}
          onWrote={() => dispatch(api.util.invalidateTags(["Tx", "Summary"]))} />
      </div>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="add-field">
      <span className="label">{label}</span>
      {children}
    </label>
  );
}

// ---- AI shortcuts (text parse + receipt photo) -------------------------------

function AiPanel({ hasAiKey, accounts, cats, onWrote }: {
  hasAiKey: boolean;
  accounts: { value: string; label: string }[];
  cats: { id: number; name: string; is_income?: boolean | number | null }[];
  onWrote: () => void;
}) {
  const t = useT();
  const [addTx, { isLoading: saving }] = useAddTransactionMutation();
  // Share-target (PWA): «поділитись» текстом у Money Track відкриває цю сторінку з `?shared=…`.
  // Прибираємо параметр з URL одразу — інакше перезавантаження сторінки знову підставило б той
  // самий текст поверх того, що людина вже встигла набрати.
  const [text, setText] = useState(() => {
    const p = new URLSearchParams(window.location.search);
    return [p.get("title"), p.get("text"), p.get("shared")].filter(Boolean).join(" ").trim();
  });
  const [parsing, setParsing] = useState(false);
  const [parsed, setParsed] = useState<ParsedText | null>(null);
  useEffect(() => {
    if (window.location.search) window.history.replaceState(null, "", window.location.pathname);
  }, []);
  const [account, setAccount] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [params, setParams] = useSearchParams();
  const [uploading, setUploading] = useState(false);
  const [receipt, setReceipt] = useState<ReceiptResponse | null>(null);

  async function uploadReceipt(file: File) {
    setReceipt(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("image", file);
      const res = await fetch("/ingest/receipt", { method: "POST", body: fd });
      const data = (await res.json()) as ReceiptResponse;
      if (!res.ok || data.error) throw new Error(data.error ?? "receipt read failed");
      setReceipt(data);
      // The endpoint lives outside the RTK Query baseUrl, so nothing invalidates on its own.
      onWrote();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  /**
   * A receipt photo shared into the app from the system share sheet.
   *
   * The service worker parked the file and redirected here with `?shared=receipt` (a POST share
   * target is delivered to the SW, never to the server — see `src/sw.ts`). This picks it up and
   * runs the ordinary upload, so the shared path and the camera button produce the same result.
   *
   * The marker is removed from the URL first: a reload with `?shared=receipt` still in it would
   * look like a second share, and the cache entry is already gone by then.
   */
  useEffect(() => {
    if (params.get("shared") !== "receipt") return;
    setParams((p) => { p.delete("shared"); return p; }, { replace: true });
    void takeSharedReceipt().then((file) => {
      if (!file) return;
      toast.success(t("add.sharedReceipt"));
      void uploadReceipt(file);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once for the share that opened this page
  }, []);

  async function parse() {
    setParsing(true);
    try {
      const res = await fetch("/ingest/text", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = (await res.json()) as { result?: ParsedText; error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? "parse failed");
      setParsed(data.result!);
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setParsing(false);
    }
  }

  async function save() {
    if (!parsed) return;
    const onCard = account !== "";
    try {
      await addTx({
        account_id: onCard ? account : undefined,
        source: onCard ? "manual" : "cash",
        amount: -Math.round(parsed.amount * 100),
        currency_code: currencyCode(parsed.currency),
        merchant: parsed.merchant,
        category_id: parsed.category_guess,
        user_note: parsed.note,
      }).unwrap();
      toast.success(t("add.toastSaved", { name: parsed.merchant }));
      setParsed(null);
      setText("");
    } catch (e) { toast.error(errText(e)); }
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="card ai-block">
        <div className="ai-block-head">
          <span className="ai-block-title"><Icon name="spark" size={16} />{t("add.aiTitle")}</span>
        </div>

        {/* Honest about the gate instead of letting the button fail: with open registration most
            new accounts have no key, and a dead "Parse with AI" is the first thing they would meet. */}
        {!hasAiKey ? (
          <p className="ai-block-hint">
            {t("add.aiNeedsKey")} <a href="/setup?tab=data">{t("add.aiNeedsKeyCta")} →</a>
          </p>
        ) : (
          <>
            <p className="ai-block-hint">{t("add.aiHint")}</p>
            <div className="row" style={{ gap: 8 }}>
              <input
                placeholder={t("add.textPlaceholder")}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && text && parse()}
                style={{ flex: 1, minWidth: 0 }}
              />
              <button className="btn" onClick={parse} disabled={!text || parsing}>
                {parsing ? t("add.parsingBtn") : t("add.parseBtn")}
              </button>
            </div>

            <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden
              onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadReceipt(f); }} />
            <button className="btn ghost" style={{ marginTop: 10, width: "100%" }}
              onClick={() => fileRef.current?.click()} disabled={uploading}>
              <Icon name="export" size={15} />
              {uploading ? t("add.recognizingReceipt") : t("add.photoReceiptBtn")}
            </button>
          </>
        )}
      </div>

      {parsed && (
        <div className="card add-form">
          <div className="label" style={{ marginBottom: 8 }}>{t("add.parsedTitle")}</div>
          <Field label={t("add.merchantLabel")}>
            <input value={parsed.merchant} onChange={(e) => setParsed({ ...parsed, merchant: e.target.value })} />
          </Field>
          <Field label={t("add.amountLabel")}>
            <input type="number" value={parsed.amount}
              onChange={(e) => setParsed({ ...parsed, amount: Number(e.target.value) })} />
          </Field>
          <Field label={t("tx.label.category")}>
            <Select
              value={parsed.category_guess}
              options={cats.filter((c) => !c.is_income).map((c) => ({ value: c.id, label: c.name }))}
              clearable placeholder={t("add.noCategory")}
              onChange={(v) => setParsed({ ...parsed, category_guess: v == null ? null : Number(v) })}
            />
          </Field>
          <Field label={t("add.accountLabel")}>
            <Select value={account || null} options={accounts} clearable
              clearLabel={t("add.cashOption")} placeholder={t("add.cashOption")}
              onChange={(v) => setAccount(v == null ? "" : String(v))} />
          </Field>
          <button className="btn primary" onClick={save} disabled={saving}>{t("add.saveExpenseBtn")}</button>
        </div>
      )}

      {receipt?.result && (
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <strong>{receipt.result.store || t("add.receiptFallback")}</strong>
            <span className="mono">{fmtMoney(receipt.result.total, receipt.result.currency)}</span>
          </div>
          <div className={receipt.matched ? "pos" : "muted"} style={{ fontSize: 12, marginTop: 4 }}>
            {receipt.matched
              ? t("add.matchedToMono")
              : receipt.transactionId ? t("add.createdCashTx") : t("add.savedReceiptOnly")}
          </div>
          {receipt.result.items.length > 0 && (
            <div className="ledger" style={{ borderTop: "1px solid var(--line)", paddingTop: 6, marginTop: 8 }}>
              {receipt.result.items.map((it, i) => (
                <div key={i} className="row" style={{ justifyContent: "space-between", padding: "4px 0" }}>
                  <span style={{ fontSize: 13 }}>{it.name}{it.qty && it.qty !== 1 ? ` ×${it.qty}` : ""}</span>
                  <span className="mono" style={{ fontSize: 13 }}>{fmtMoney(it.price, receipt.result!.currency)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
