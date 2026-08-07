// §6 Вагомість — which importance levels exist, and what an unknown one means.
//
// Lives in `lib/` rather than next to a route because both the route layer and `services/`
// normalise it, and a layer below must never import from one above. The levels themselves are
// the canon read by `EFF_IMPORTANCE` in `stats.ts`.
const IMPORTANCE = new Set(["essential", "discretionary", "optional"]);

/** Valid level, or NULL (a reset) for anything else — including `""` and `null`. */
export function normImportance(v: string | null | undefined): string | null {
  return v && IMPORTANCE.has(v) ? v : null;
}
