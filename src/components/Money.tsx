import { currencySign, formatMinor } from "../lib/format.ts";

interface Props {
  minor: number;
  currency?: number;
  decimals?: boolean;
  signed?: boolean; // colour + explicit sign for +/-
  className?: string;
}

/** Money in tabular Geist Mono with a small currency sign (plan §8). */
export function Money({ minor, currency = 980, decimals = true, signed = false, className }: Props) {
  const cls = signed ? (minor < 0 ? "neg" : minor > 0 ? "pos" : "") : "";
  const prefix = signed && minor > 0 ? "+" : "";
  return (
    <span className={`money ${cls} ${className ?? ""}`}>
      {prefix}
      {formatMinor(minor, { decimals })}
      <span className="cur">{currencySign(currency)}</span>
    </span>
  );
}
