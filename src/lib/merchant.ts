// Бренд-стилі мерчантів переїхали в lib/brands.tsx (локально, без зовнішніх запитів).
// Тут лишається лише визначення типу фізичної картки за назвою рахунку.

export type CardKind = "black" | "white" | "fop" | "jar" | "other";

export function cardKind(title: string | null): CardKind {
  const t = (title ?? "").toLowerCase();
  if (t.includes("black")) return "black";
  if (t.includes("white") || t.includes("platinum")) return "white";
  if (t.includes("fop") || t.includes("фоп")) return "fop";
  if (t.includes("jar") || t.includes("банка")) return "jar";
  return "other";
}

const CARD_KIND_LABEL: Record<CardKind, string> = {
  black: "Чорна картка", white: "Біла картка", fop: "ФОП-картка", jar: "Банка", other: "Рахунок",
};
export function cardKindLabel(kind: CardKind): string {
  return CARD_KIND_LABEL[kind];
}

// Людська назва за ТИПОМ рахунку (`account.type`) — коротка форма для списку Рахунків.
// Домен ширший за CardKind (є crypto/cash/manual_card/platinum) і навмисно коротший
// («Чорна», не «Чорна картка»): у списку тип уже в контексті картки. Єдине джерело
// вокабуляру типів рахунків — тут (був дубльований інлайном у Accounts.tsx).
const ACCOUNT_TYPE_LABEL: Record<string, string> = {
  black: "Чорна", white: "Біла", platinum: "Platinum", fop: "ФОП",
  jar: "Банка", cash: "Готівка", manual_card: "Картка", crypto: "Крипта",
};
export function accountTypeLabel(type: string): string | undefined {
  return ACCOUNT_TYPE_LABEL[type];
}

// account_title з бекенду — конкатенація "<type> <··маскований PAN>" (repo.ts titleFor).
// Дістаємо останні 4 цифри для компактного бейджа картки (·· 4932).
export function cardLast4(title: string | null | undefined): string | null {
  if (!title) return null;
  const m = title.match(/(\d{4})\s*$/);
  return m ? `··${m[1]}` : null;
}

// Людська назва рахунку: «white 444111******5181» → «Біла картка ··5181», банка/крипта
// лишають власну назву («На квартиру»). Сирий PAN — шум (§11.3 прибрав його зі списку),
// але останні 4 лишаємо: карток одного типу кілька (3 чорні в різних валютах), без них
// «Чорна картка» неоднозначна.
export function accountLabel(title: string | null | undefined): string {
  if (!title) return "—";
  const last4 = cardLast4(title);
  const kind = cardKind(title);
  if (!last4) return kind === "fop" ? cardKindLabel(kind) : title;
  if (kind !== "other") return `${cardKindLabel(kind)} ${last4}`;
  // Тип, якого нема в CardKind (madeInUkraine…): лишаємо його назву, ховаємо маску PAN.
  const type = title.replace(/[\d*\s]+$/, "").trim();
  return type ? `${type} ${last4}` : last4;
}
