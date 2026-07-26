// Localized display names for the SEED category taxonomy (P3.4, PLATFORM.md §12.4).
//
// Category names live in the DB and are user-editable, so they are data, not a UI dictionary.
// The seed set (ids 1–47, migrations 0002/0005) is a fixed, known list; a user-renamed or
// user-created category is NOT in this map and passes through unchanged — renaming a category
// makes the name "theirs", exactly as §12.4 intends. We key by the stored Ukrainian NAME rather
// than adding a `name_key` column: the mapping is a pure function of the seed string, so it
// needs no migration and no threading of a key through the ~40 places that already select the
// name. Resolution happens SERVER-SIDE in the owner's locale (client is unchanged), via a SQL
// CASE expression built here — the same inline-CASE technique the canon already uses for
// currency (`uahMult` in stats.ts).
//
// Trade-off, stated plainly: value-keyed resolution mistranslates only if a user renames a
// category to another seed's EXACT Ukrainian string — negligible, and it only affects a display
// label, never a number.

import type { NotifLocale } from "../../../shared/notif-i18n.ts";
import type { AppDb } from "../platform/db-shim.ts";
import { getState } from "./repo.ts";

// Stored Ukrainian seed name -> English. Keys MUST byte-match the seed (note the modifier
// apostrophe ʼ in «Здоровʼя»/«звʼязок»). uk output is the key itself, so no uk table is needed.
export const CAT_EN: Record<string, string> = {
  // expense parents (0002)
  "Продукти": "Groceries",
  "Кафе і ресторани": "Cafés & restaurants",
  "Транспорт": "Transport",
  "Здоровʼя": "Health",
  "Одяг і взуття": "Clothing & shoes",
  "Розваги": "Entertainment",
  "Комуналка і звʼязок": "Utilities & connectivity",
  "Дім і побут": "Home & household",
  "Електроніка": "Electronics",
  "Краса і догляд": "Beauty & care",
  "Подорожі": "Travel",
  "Підписки": "Subscriptions",
  "Перекази і зняття": "Transfers & withdrawals",
  "Інше": "Other",
  // income (0002)
  "Зарплата": "Salary",
  "Фріланс": "Freelance",
  "Повернення": "Refund",
  "Інші надходження": "Other income",
  // expense parents (0005)
  "Освіта": "Education",
  "Діти": "Children",
  "Тварини": "Pets",
  "Спорт і фітнес": "Sports & fitness",
  "Подарунки": "Gifts",
  "Податки": "Taxes",
  // tax subcategories (0005)
  "Єдиний податок": "Single tax",
  "ЄСВ": "Social contribution",
  "Військовий збір": "Military levy",
  "ПДФО": "Personal income tax",
  // expense subcategories (0005)
  "Супермаркет": "Supermarket",
  "Ринок": "Market",
  "Кава": "Coffee",
  "Ресторани": "Restaurants",
  "Доставка їжі": "Food delivery",
  "Таксі": "Taxi",
  "Пальне": "Fuel",
  "Громадський": "Public transit",
  "Кіно": "Cinema",
  "Ігри": "Games",
  "Аптека": "Pharmacy",
  "Лікар": "Doctor",
  "Стрімінги": "Streaming",
  "Софт і хмара": "Software & cloud",
  // income subcategories (0005)
  "Продаж": "Sale",
  "Кешбек": "Cashback",
  "Проценти": "Interest",
  "Подарунок": "Gift",
};

/** Owner UI locale, read from app_state. Only `en` triggers translation; `uk` is the stored form. */
export async function ownerLocale(db: AppDb): Promise<NotifLocale> {
  return (await getState(db, "locale")) === "en" ? "en" : "uk";
}

/** JS-side: localize a single stored category name. Unknown (user) names pass through. */
export function localizeCatName(locale: NotifLocale, name: string | null): string | null {
  if (locale !== "en" || name == null) return name;
  return CAT_EN[name] ?? name;
}

// Escaped SQL string literals for the CASE, built once. Values are hardcoded here (not user
// input), but escape defensively so a future entry with an apostrophe can't break the query.
const sqlLit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const CASE_WHENS = Object.entries(CAT_EN)
  .map(([uk, en]) => `WHEN ${sqlLit(uk)} THEN ${sqlLit(en)}`)
  .join(" ");

/**
 * SQL expression that resolves a category-name expression to the owner's locale. For `uk` it is
 * a no-op (returns `expr` unchanged, zero cost); for `en` it wraps `expr` in a CASE over the
 * seed names. `expr` may be a column (`c.name`) or the canonical roll-up (`EFF_CAT_NAME`). The
 * operand is evaluated once by the CASE and once by ELSE — cheap even for the COALESCE form.
 */
export function catNameSql(locale: NotifLocale, expr: string): string {
  if (locale !== "en") return expr;
  return `CASE ${expr} ${CASE_WHENS} ELSE ${expr} END`;
}
