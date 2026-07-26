import { Link } from "react-router-dom";
import { formatDate } from "../../lib/format.ts";
import { Money } from "../ui/Money.tsx";
import { MerchantLogo } from "../ui/MerchantLogo.tsx";
import { Icon } from "../ui/Icon.tsx";
import { isNeutralTransfer, transferRoute } from "../../lib/transfer.ts";
import { useT } from "../../i18n/index.ts";

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
  real_category_id?: number | null;
  transfer_pair_id?: string | null;
  pair_account_title?: string | null;
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
  const tr = useT();
  const transfer = !!t.is_transfer;
  const groupColor = t.event_id ? (t.event_color ?? "var(--accent)") : null;
  const isSel = selected ?? false;
  // Переказ між своїми — не витрата й не дохід: без знака, без червоного (`lib/transfer.ts`).
  const neutral = isNeutralTransfer(t);
  const route = transferRoute(t);

  // Клітинки-осередки (logo · who · cat · date · amt) розкладаються сіткою:
  // stacked у 2 рядки (вузько) або вирівняні колонки (широко) — керує CSS-контейнер (§11.3).
  // Повтор ··4932 прибрано як шум; спосіб оплати видно в деталях операції.
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
      <div className="tx-body">
        <div className="tx-line1">
          <span className="who-name">{t.merchant ?? t.comment ?? "—"}</span>
          {t.planned_id != null && !transfer && (
            <span className="m-sub" title={tr("tx.subCharge")}>🔁</span>
          )}
          {t.event_name && (
            <span className="m-group" style={{ color: groupColor ?? undefined }} title={t.event_name}>
              <span className="d" style={{ background: groupColor ?? "var(--accent)" }} />{t.event_name}
            </span>
          )}
        </div>
        <div className="tx-line2">
          <span className="tx-cat">
            {!transfer && <span className="d" style={{ background: t.category_color ?? "var(--muted)" }} />}
            {route ? (
              // Маршрут замість слова «переказ»: той самий рядок несе більше сенсу.
              <span className="tx-route-mini">
                <span className="tr-acc">{route.from}</span>
                <Icon name="arrowRight" size={12} className="tr-arrow" />
                <span className="tr-acc">{route.to}</span>
              </span>
            ) : (
              <span className="tx-cat-name">{transfer ? tr("tx.transfer") : (t.category_name ?? tr("tx.noCategory"))}</span>
            )}
          </span>
          <span className="tx-date">{formatDate(t.time)}</span>
        </div>
      </div>
      <div className="amt">
        {neutral ? (
          <span className="amt-neutral">
            <Icon name="swap" size={13} className="amt-swap" />
            <Money minor={Math.abs(t.amount)} currency={t.currency_code} className="neutral" />
          </span>
        ) : (
          <Money minor={t.amount} currency={t.currency_code} signed />
        )}
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
