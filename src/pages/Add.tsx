import { useRef, useState } from "react";
import { getLocale, localeTag } from "../i18n/locale.ts";
import { useDispatch } from "react-redux";
import { api, useAddTransactionMutation, useGetAccountsQuery, useGetCategoriesQuery } from "../store/api.ts";
import { toast } from "../lib/toast.ts";
import { errText } from "../lib/errors.ts";
import { useT } from "../i18n/index.ts";

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

const currencyCode = (c: string): number => (c === "USD" ? 840 : c === "EUR" ? 978 : 980);
const fmtMoney = (major: number, cur: string): string =>
  `${major.toLocaleString(localeTag(getLocale()), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}`;

// Швидкий ввід: текст -> Haiku розбирає -> підтверджую -> зберігаю (§6.2).
export function Add() {
  const t = useT();
  const { data: accounts } = useGetAccountsQuery();
  const { data: cats } = useGetCategoriesQuery();
  const [addTx, { isLoading: saving }] = useAddTransactionMutation();
  const dispatch = useDispatch();

  const [text, setText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [parsed, setParsed] = useState<ParsedText | null>(null);
  const [account, setAccount] = useState("");

  // Receipt photo (§6.1): POST image to /ingest/receipt → Haiku reads it, backend
  // stores in R2, matches an existing mono tx by amount+date or creates a cash tx.
  const fileRef = useRef<HTMLInputElement>(null);
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
      // Endpoint is outside the RTK Query baseUrl, so invalidate manually to refresh
      // the dashboard total and the recent-transactions list.
      dispatch(api.util.invalidateTags(["Tx", "Summary"]));
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

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
    // Готівка йде на окремий cash-рахунок (бекенд створить його за потреби). Якщо
    // вибрано конкретну картку — використовуємо її як manual-запис на цю картку.
    const onCard = account && account !== "cash";
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
  }

  return (
    <>
      <div className="page-head">
        <div>
          <div className="greet">{t("add.title")}</div>
          <div className="sub">{t("add.subtitle")}</div>
        </div>
      </div>
      <div className="stack">
        <input
          placeholder={t("add.textPlaceholder")}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && text && parse()}
        />
        <button className="btn primary" onClick={parse} disabled={!text || parsing}>
          {parsing ? t("add.parsingBtn") : t("add.parseBtn")}
        </button>

        {parsed && (
          <div className="card" style={{ padding: 16 }}>
            <div className="stack">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span className="label">{t("add.merchantLabel")}</span>
                <input value={parsed.merchant} onChange={(e) => setParsed({ ...parsed, merchant: e.target.value })} style={{ maxWidth: 220 }} />
              </div>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span className="label">{t("add.amountLabel")}</span>
                <input type="number" value={parsed.amount} onChange={(e) => setParsed({ ...parsed, amount: Number(e.target.value) })} style={{ maxWidth: 120 }} />
              </div>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span className="label">{t("tx.label.category")}</span>
                <select value={parsed.category_guess ?? ""} onChange={(e) => setParsed({ ...parsed, category_guess: e.target.value ? Number(e.target.value) : null })} style={{ maxWidth: 220 }}>
                  <option value="">—</option>
                  {cats?.filter((c) => !c.is_income).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span className="label">{t("add.accountLabel")}</span>
                <select value={account} onChange={(e) => setAccount(e.target.value)} style={{ maxWidth: 220 }}>
                  <option value="">{t("add.autoAccountOption")}</option>
                  {accounts?.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
                </select>
              </div>
              <button className="btn primary" onClick={save} disabled={saving}>{t("add.saveExpenseBtn")}</button>
            </div>
          </div>
        )}

        <div className="section-head" style={{ marginTop: 8 }}><h2>{t("add.receiptPhotoTitle")}</h2></div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) uploadReceipt(f);
          }}
        />
        <button className="btn" onClick={() => fileRef.current?.click()} disabled={uploading}>
          {uploading ? t("add.recognizingReceipt") : t("add.photoReceiptBtn")}
        </button>

        {receipt?.result && (
          <div className="card" style={{ padding: 16 }}>
            <div className="stack" style={{ gap: 8 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong>{receipt.result.store || t("add.receiptFallback")}</strong>
                <span className="mono">{fmtMoney(receipt.result.total, receipt.result.currency)}</span>
              </div>
              <div className={receipt.matched ? "pos" : "muted"} style={{ fontSize: 12 }}>
                {receipt.matched
                  ? t("add.matchedToMono")
                  : receipt.transactionId
                    ? t("add.createdCashTx")
                    : t("add.savedReceiptOnly")}
              </div>
              {receipt.result.items.length > 0 && (
                <div className="ledger" style={{ borderTop: "1px solid var(--line)", paddingTop: 6 }}>
                  {receipt.result.items.map((it, i) => (
                    <div key={i} className="row" style={{ justifyContent: "space-between", padding: "4px 0" }}>
                      <span style={{ fontSize: 13 }}>
                        {it.name}{it.qty && it.qty !== 1 ? ` ×${it.qty}` : ""}
                      </span>
                      <span className="mono" style={{ fontSize: 13 }}>
                        {fmtMoney(it.price, receipt.result!.currency)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
