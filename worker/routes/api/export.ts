// `/export/*` and `/search` — getting data back out.
//
// The backup enumerates tables from the SCHEMA, not from a list in code: a dump that silently
// misses a table added by a later migration is worse than no dump, because it looks like one.
import { getRates } from "../../lib/finance/finance.ts";
import {
  valueMode, } from "../../lib/finance/stats.ts";
import * as txRepo from "../../repo/transactions.ts";
import { st } from "../../lib/platform/i18n.ts";
import { buildDump } from "../../lib/platform/backup.ts";
import { apiRoutes } from "./_shared.ts";
import type { SearchResults } from "../../../shared/api/platform.ts";

export const dataExport = apiRoutes();

// L10 — повний дамп власних даних одним файлом.
//
// Причина існування: дані живуть в ОДНОМУ Durable Object і бекапів немає (усвідомлена межа,
// записана в §Де і як лежать дані). CSV-експорт віддає лише операції — без категорій, рахунків,
// планів, бюджетів, цілей, чеків і сповіщень. Тобто найгірший сценарій («обʼєкт зник») не був
// закритий узагалі. Кнопка «вивантажити все» коштує майже нічого і закриває його.
//
// **Таблиці читаються з `sqlite_master`, а не зі списку в коді.** Бекап, який мовчки не бере
// таблицю з наступної міграції, гірший за відсутність бекапу: він виглядає як бекап. Тому
// сюди автоматично потрапляє все, що не в денилисті нижче.
// ⚠️ Формат файлу тут БІЛЬШЕ НЕ БУДУЄТЬСЯ (2026-08-08). Дамп робить `lib/platform/backup.ts`
// `buildDump`, і той самий байт-у-байт файл пише нічний бекап у R2 та приймає відновлення.
// Доти формат жив тут, а бекапів не існувало взагалі — щойно вони зʼявились, дві реалізації
// одного файлу означали б, що ручний експорт і автоматичний бекап можуть розійтись, і виявилось
// би це рівно в той день, коли когось із них треба відновити.
dataExport.get("/export/all.json", async (c) => {
  let body: string;
  try {
    body = (await buildDump(c.env.DB)).json;
  } catch {
    // Схему не вдалося прочитати — це НЕ «даних немає». Віддати за цієї умови «успішний» файл
    // на кілька байт було б найгіршим результатом: людина вважала б, що бекап у неї є.
    return c.json({ error: "export_schema_unreadable" }, 500);
  }
  const day = new Date().toISOString().slice(0, 10);
  return new Response(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="money-track-${day}.json"`,
      "cache-control": "no-store",
    },
  });
});

// §J: CSV-експорт транзакцій (для бухгалтера/податкової). Опційні from/to (unix). BOM для
// коректної кирилиці в Excel; сума — у валюті рахунку. Пара-переказ — один рядок (як у списку).
const CUR_ALPHA: Record<number, string> = { 980: "UAH", 840: "USD", 978: "EUR", 985: "PLN", 826: "GBP", 756: "CHF" };
dataExport.get("/export/transactions.csv", async (c) => {
  const url = new URL(c.req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const rows = await txRepo.forCsvExport(
    c.env.DB, c.get("locale"), from ? Number(from) : null, to ? Number(to) : null);
  // ---- CSV dialect (B2) ----------------------------------------------------
  // The RFC-4180 file we used to emit (`,` + decimal point) opens as ONE column in Excel on a
  // Ukrainian/European locale, which reads as "the export is broken" — and even after splitting
  // it by hand the amount column will not sum, because `-1234.56` is text where the decimal mark
  // is a comma. Neither failure is loud; the file just looks wrong.
  //
  // So the default is the dialect that opens correctly on a double-click here: `sep=;` (Excel
  // honours it, Sheets accepts it), `;` between fields, `,` as the decimal mark. `?dialect=rfc`
  // keeps the strict form for a script or a US-locale sheet, because guessing wrong there is the
  // same silent breakage in the other direction.
  const rfc = url.searchParams.get("dialect") === "rfc";
  const sep = rfc ? "," : ";";
  const num = (n: number) => (rfc ? n.toFixed(2) : n.toFixed(2).replace(".", ","));
  // Whether a cell is "a plain number" depends on the decimal mark in use — see the exemption
  // below. Getting this wrong is not cosmetic: every negative amount would be quoted into text
  // and the amount column would stop summing, which is precisely the bug being fixed.
  const numeric = rfc ? /^-?\d+(\.\d+)?$/ : /^-?\d+(,\d+)?$/;
  // Quoting must follow the ACTIVE separator, not a hardcoded comma: with `;` fields, a value
  // containing `;` is what needs quoting, and a value containing `,` no longer does.
  const needsQuote = new RegExp(`["${sep === ";" ? ";" : ","}\\n\\r]`);

  const esc = (v: unknown) => {
    let s = v == null ? "" : String(v);
    // CSV formula injection (fixed 2026-07-26, security review). Excel/Sheets execute a cell that
    // starts with = + - @ or a leading tab/CR, and one of these columns is the bank COMMENT —
    // text a stranger types when sending a P2P transfer. So an attacker picks the payload, the
    // victim opens their own export, and the spreadsheet runs it. A leading apostrophe makes the
    // cell literal text; it is the standard defence and costs one character in the file.
    // A plain number is exempt — otherwise every negative amount would be quoted into text and
    // the Сума column would stop summing, which is the whole reason to export a CSV.
    if (/^[=+\-@\t\r]/.test(s) && !numeric.test(s)) s = `'${s}`;
    return needsQuote.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const loc = c.get("locale");
  const header = [
    st(loc, "csvDate"), st(loc, "csvMerchant"), st(loc, "csvComment"), st(loc, "csvNote"),
    st(loc, "csvAmount"), st(loc, "csvCurrency"), st(loc, "csvCategory"), st(loc, "csvAccount"),
    st(loc, "csvGroup"), st(loc, "csvTransfer"),
  ];
  const lines = [header.map(esc).join(sep)];
  for (const r of rows) {
    lines.push([
      new Date(r.time * 1000).toISOString().slice(0, 10),
      r.merchant ?? "", r.comment ?? "", r.user_note ?? "",
      num(r.amount / 100), CUR_ALPHA[r.currency_code] ?? String(r.currency_code),
      r.category_name ?? "", r.account_title ?? "", r.event_name ?? "",
      r.is_transfer ? st(loc, "csvYes") : "",
    ].map(esc).join(sep));
  }
  // BOM keeps Cyrillic readable in Excel; the `sep=` hint must come AFTER it and before the
  // header, which is the only position Excel recognises.
  const csv = "﻿" + (rfc ? "" : `sep=${sep}\r\n`) + lines.join("\r\n");
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="money-track-transactions.csv"`,
    },
  });
});

/**
 * Глобальний пошук для командної панелі (Ctrl-K): мерчанти, категорії, конкретні операції.
 * Сторінки й дії — статичні, їх фільтрує клієнт (нема сенсу ганяти по мережі).
 *
 * Свідомо ДЕШЕВИЙ: короткі LIMIT-и й префіксний LIKE — панель смикає це на кожен ввід.
 * Мерчанти зводимо агрегатом (сума/кількість), щоб рядок одразу щось означав, а не був
 * просто назвою: «Сільпо · 34 операції · 12 400 ₴» відповідає на питання ще до кліку.
 */
dataExport.get("/search", async (c) => {
  const q = (new URL(c.req.url).searchParams.get("q") ?? "").trim();
  if (q.length < 2) return c.json({ merchants: [], categories: [], transactions: [] } satisfies SearchResults);
  const rates = await getRates(c.env.DB);
  const { mult } = valueMode(rates, null);

  // ⚠️ SQLite згортає регістр ТІЛЬКИ для ASCII: `LOWER('Сільпо')` = `'Сільпо'` (перевірено
  // на D1). Тобто `LIKE '%сільпо%'` НІКОЛИ не знайде «Сільпо» — а це основна мова застосунку,
  // тож наївний LIKE зробив би пошук марним. Складаємо регістрові варіанти в JS (він
  // Unicode-aware) і матчимо через OR. Покриває реальні введення: усе малими, усе великими,
  // з великої літери. Екзотичний внутрішній регістр («МакДональдз» на запит «макдональдз»)
  // лишається поза — це свідомий компроміс проти сканування всієї таблиці на кожну літеру.
  const variants = [...new Set([q, q.toLocaleLowerCase("uk"), q.toLocaleUpperCase("uk"),
    q.charAt(0).toLocaleUpperCase("uk") + q.slice(1).toLocaleLowerCase("uk")])];

  return c.json(await txRepo.search(c.env.DB, c.get("locale"), mult, variants) satisfies SearchResults);
});
