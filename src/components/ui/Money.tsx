import { currencySign, formatMinor } from "../../lib/format.ts";
import { baseSign } from "../../lib/currency.ts";

interface Props {
  minor: number;
  /** Omit for a rolled-up figure: it is in the reader's display base (§BASE-CUR). Pass a code
   *  only when the amount really is in ONE currency of its own — an account, a plan, one row. */
  currency?: number;
  decimals?: boolean;
  signed?: boolean; // colour + explicit sign for +/-
  className?: string;
}

/** Money in tabular Geist Mono with a small currency sign (plan §8). */
export function Money({ minor, currency, decimals = true, signed = false, className }: Props) {
  const cls = signed ? (minor < 0 ? "neg" : minor > 0 ? "pos" : "") : "";
  const prefix = signed && minor > 0 ? "+" : "";
  return (
    <span className={`money ${cls} ${className ?? ""}`}>
      {prefix}
      {formatMinor(minor, { decimals })}
      <span className="cur">{currency == null ? baseSign() : currencySign(currency)}</span>
    </span>
  );
}
