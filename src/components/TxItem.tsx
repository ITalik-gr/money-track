import { Link } from "react-router-dom";
import { formatDate } from "../lib/format.ts";
import { cardKind, cardLast4 } from "../lib/merchant.ts";
import { Money } from "./Money.tsx";
import { MerchantLogo } from "./MerchantLogo.tsx";

// Спільний рядок транзакції (роадмап §1 «TxRow»): один вигляд для списку операцій і для
// дрилів Статистики. `compact` — менша висота/шрифт для вкладених дрилів. Приймає широку
// (TxRow) або вузьку (DrillTx) форму — усі поля крім id/time/amount/currency опційні.
export interface TxItemData {
  id: string;
  time: number;
  amount: number;
  currency_code: number;
  merchant?: string | null;
  comment?: string | null;
  category_name?: string | null;
  category_color?: string | null;
  category_icon?: string | null;
  account_title?: string | null;
  is_transfer?: number;
  planned_id?: number | null;
  event_id?: number | null;
  event_name?: string | null;
  event_color?: string | null;
  hold?: number;
}

interface Props {
  t: TxItemData;
  compact?: boolean;
  selectable?: boolean;
  selected?: boolean;
  onToggle?: (id: string) => void;
}

export function TxItem({ t, compact, selectable, selected, onToggle }: Props) {
  const last4 = cardLast4(t.account_title);
  const kind = cardKind(t.account_title ?? null);
  const transfer = !!t.is_transfer;
  const groupColor = t.event_id ? (t.event_color ?? "var(--accent)") : null;
  const isSel = selected ?? false;

  const inner = (
    <>
      {selectable && (
        <span className={`tx-check ${isSel ? "on" : ""}`} aria-hidden="true">
          {isSel && (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 6" /></svg>
          )}
        </span>
      )}
      <MerchantLogo merchant={t.merchant ?? null} catIcon={t.category_icon ?? null} color={t.category_color ?? null} transfer={transfer} fallbackLabel={t.category_name ?? null} />
      <div style={{ minWidth: 0 }}>
        <div className="who">{t.merchant ?? t.comment ?? "—"}</div>
        <div className="meta">
          <span>{formatDate(t.time)}</span>
          <span className="sep">·</span>
          <span className="m-cat">
            {!transfer && <span className="d" style={{ background: t.category_color ?? "var(--muted)" }} />}
            {transfer ? "переказ" : (t.category_name ?? "без категорії")}
          </span>
          {t.planned_id != null && !transfer && (
            <span className="m-sub" title="Списання підписки">🔁 підписка</span>
          )}
          {t.event_name && (
            <span className="m-group" style={{ color: groupColor ?? undefined }}>
              <span className="d" style={{ background: groupColor ?? "var(--accent)" }} />{t.event_name}
            </span>
          )}
          {last4 && (
            <>
              <span className="sep">·</span>
              <span className={`card-badge ${kind}`}><span className="sq" />{last4}</span>
            </>
          )}
        </div>
      </div>
      <div className="amt">
        <Money minor={t.amount} currency={t.currency_code} signed />
      </div>
    </>
  );

  const cls = `tx tappable ${compact ? "tx-sm" : ""} ${transfer ? "is-transfer" : ""} ${groupColor ? "in-group" : ""} ${isSel ? "tx-selected" : ""}`;
  const style = groupColor ? { "--group-color": groupColor } as React.CSSProperties : undefined;

  if (selectable) {
    return (
      <div className={cls} style={style} onClick={() => onToggle?.(t.id)} role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle?.(t.id); } }}>
        {inner}
      </div>
    );
  }
  return (
    <Link to={`/tx/${t.id}`} className={cls} style={style}>
      {inner}
    </Link>
  );
}
