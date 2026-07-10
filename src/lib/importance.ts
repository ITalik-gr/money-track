// §6 Вагомість витрат — 3 рівні. Спільні лейбли/кольори для пікерів і статистики.
export type Importance = "essential" | "discretionary" | "optional";
export const IMPORTANCE_LEVELS: Importance[] = ["essential", "discretionary", "optional"];

export const IMPORTANCE_META: Record<Importance, { label: string; short: string; color: string; hint: string }> = {
  essential:     { label: "Обов'язкова",   short: "Обов.",  color: "#127c86", hint: "Не можна не робити (їжа, житло, комуналка, ліки)" },
  discretionary: { label: "Бажана",         short: "Бажана", color: "#c9871a", hint: "Корисна, але гнучка (кафе, покупки)" },
  optional:      { label: "Необов'язкова",  short: "Необ.",  color: "#b23a2e", hint: "Можна не робити (розваги, розкіш)" },
};

export function importanceMeta(v: string | null | undefined) {
  return v && v in IMPORTANCE_META ? IMPORTANCE_META[v as Importance] : null;
}
