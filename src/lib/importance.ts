// §6 Вагомість витрат — 3 рівні. Спільні лейбли/кольори для пікерів і статистики.
import type { TranslationKey } from "../i18n/index.ts";

export type Importance = "essential" | "discretionary" | "optional";
export const IMPORTANCE_LEVELS: Importance[] = ["essential", "discretionary", "optional"];

// labelKey/shortKey/hintKey — тримають ключ перекладу, не готовий текст: споживачі
// (Stats.tsx/Reports.tsx/TxDetail.tsx/CategoryModal.tsx/Transactions.tsx) резолвлять
// через t()/translate() у себе, щоб лишатись реактивними до живого перемикача мови.
export const IMPORTANCE_META: Record<Importance, { labelKey: TranslationKey; shortKey: TranslationKey; color: string; hintKey: TranslationKey }> = {
  essential:     { labelKey: "imp.meta.essential.label",     shortKey: "imp.meta.essential.short",     color: "#127c86", hintKey: "imp.meta.essential.hint" },
  discretionary: { labelKey: "imp.meta.discretionary.label", shortKey: "imp.meta.discretionary.short", color: "#c9871a", hintKey: "imp.meta.discretionary.hint" },
  optional:      { labelKey: "imp.meta.optional.label",      shortKey: "imp.meta.optional.short",      color: "#b23a2e", hintKey: "imp.meta.optional.hint" },
};

export function importanceMeta(v: string | null | undefined) {
  return v && v in IMPORTANCE_META ? IMPORTANCE_META[v as Importance] : null;
}
