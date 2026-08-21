/**
 * Receipt-line price drift — «що подорожчало у твоєму кошику».
 *
 * Pulled out of the `/analytics/price-drift` handler on 2026-08-21, when that file hit its C3
 * ceiling. The move is not just line-count arithmetic: everything below is judgement about what
 * counts as a price change, which is `lib/` work by the layering rule. A route that carries
 * thresholds and a median is a route that will grow a second opinion the next time somebody needs
 * the same number somewhere else.
 */

/** One priced line off a receipt: total paid and quantity, so unit price is derivable. */
export interface PricePoint { name: string; at: number; price: number; qty: number }

export interface DriftItem {
  name: string; first_unit: number; last_unit: number; change_pct: number;
  n: number; first_at: number; last_at: number;
}

/** Fewer sightings than this is an anecdote, not a trend. */
const MIN_N = 3;
/** Under three weeks, a promo week and a normal week look like a price change. */
const MIN_SPAN = 21 * 86400;
/** Below this, the "change" is rounding, packaging and which shop happened to be open. */
const NOISE_PCT = 5;

const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;

export function computePriceDrift(rows: PricePoint[]): {
  basket_change_pct: number | null; tracked: number; items: DriftItem[];
} {
  const byName = new Map<string, { at: number; unit: number }[]>();
  for (const r of rows) {
    const unit = r.price / r.qty;
    (byName.get(r.name) ?? byName.set(r.name, []).get(r.name)!).push({ at: r.at, unit });
  }

  const items: DriftItem[] = [];
  for (const [name, occ] of byName) {
    if (occ.length < MIN_N) continue;
    if (occ[occ.length - 1].at - occ[0].at < MIN_SPAN) continue;
    // Halves rather than first-vs-last: a single discounted purchase at either end would
    // otherwise BE the trend.
    const half = Math.ceil(occ.length / 2);
    const early = mean(occ.slice(0, half).map((o) => o.unit));
    const late = mean(occ.slice(half).map((o) => o.unit));
    if (early <= 0) continue;
    items.push({
      name, first_unit: Math.round(early), last_unit: Math.round(occ[occ.length - 1].unit),
      change_pct: Math.round(((late - early) / early) * 1000) / 10,
      n: occ.length, first_at: occ[0].at, last_at: occ[occ.length - 1].at,
    });
  }

  // Індекс кошика — медіана змін (стійка до викидів).
  const changes = items.map((i) => i.change_pct).sort((a, b) => a - b);
  const basket = changes.length
    ? (changes.length % 2 ? changes[(changes.length - 1) / 2] : (changes[changes.length / 2 - 1] + changes[changes.length / 2]) / 2)
    : null;

  return {
    basket_change_pct: basket != null ? Math.round(basket * 10) / 10 : null,
    tracked: items.length,
    // Топ рухів (лишаємо лише помітні), за модулем зміни.
    items: items.filter((i) => Math.abs(i.change_pct) >= NOISE_PCT)
      .sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct)).slice(0, 12),
  };
}
