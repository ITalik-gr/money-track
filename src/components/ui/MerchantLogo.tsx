import { matchBrand, BRAND_MARKS } from "../../lib/brands.tsx";
import { CategoryIcon } from "./CategoryIcon.tsx";

// Плитка операції — локальна, без зовнішніх запитів (приватність). Пріоритет:
// бренд-гліф → бренд-монограма (фірмовий колір) → іконка категорії → літера → крапка.
export function MerchantLogo({
  merchant, catIcon, color, transfer, fallbackLabel,
}: {
  merchant: string | null;
  catIcon?: string | null;
  color: string | null;
  transfer?: boolean;
  fallbackLabel?: string | null;
}) {
  if (transfer) {
    return <span className="cat-ico" style={{ background: "var(--muted)" }}>⇄</span>;
  }

  const brand = matchBrand(merchant);
  if (brand) {
    const fg = brand.fg ?? "#fff";
    if (brand.mark) {
      return (
        <span className="cat-ico brand-tile" style={{ background: brand.color, color: fg }}>
          <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">{BRAND_MARKS[brand.mark]}</svg>
        </span>
      );
    }
    const initial = merchant?.trim()?.[0]?.toUpperCase() ?? "•";
    return <span className="cat-ico brand-mono" style={{ background: brand.color, color: fg }}>{initial}</span>;
  }

  const letter = fallbackLabel?.trim() ? fallbackLabel.trim()[0].toUpperCase() : null;
  return (
    <span className="cat-ico" style={{ background: color ?? "var(--muted)" }}>
      {catIcon ? <CategoryIcon slug={catIcon} size={20} /> : (letter ?? <CategoryIcon slug={null} size={20} />)}
    </span>
  );
}
