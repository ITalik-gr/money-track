// L5 — prompts and persona: the stable text we put in FRONT of every request.
//
// Provider-agnostic (it is prose, not an API shape), and separated from the transport because the
// two change for completely different reasons: the transport changes when the API does, this
// changes when we learn something about how the model behaves. Both of the facts below were
// learned the hard way.
//
//  • **The cache has a MINIMUM.** Haiku 4.5 will not cache a prefix under 4 096 tokens, and our
//    base prefix measures ~789 — so `cache_control` on it silently does nothing. Caching is
//    therefore only switched on for the bulk-enrich path, where `CACHE_GUIDE` pushes the prefix
//    over the threshold (and improves quality besides).
//  • **A language instruction has TWO right answers, not one** (B6). Telling the chat "write
//    everything in English, do NOT reply in Ukrainian" made the model answer a Ukrainian question
//    in RUSSIAN — a third Slavic language that broke neither instruction literally. Hence the two
//    modes below, and the explicit ban stated in BOTH of them.
import type { Env } from "../../env.ts";
import { resolveLocale } from "../platform/i18n.ts";
import { catNameSql } from "../finance/categories-i18n.ts";
import type { AnthropicContentBlock } from "./ai.ts";



// Build the system prefix from the live category taxonomy.
// ВАЖЛИВО про кеш (виміряно count_tokens): базовий префікс ≈789 тк, а мінімум кешу
// Haiku 4.5 = 4096 тк — тож cache_control на малому префіксі МОВЧКИ не працює.
// Тому кешування вмикаємо лише коли cached=true (масовий enrich): додаємо великий
// СТАБІЛЬНИЙ гайд (CACHE_GUIDE, також покращує якість) з cache_control, щоб перетнути
// поріг. Поодинокі/інтерактивні виклики лишаємо «лін» (без кешу — малий префікс дешевий).
export async function buildSystemPrefix(env: Env, task: string, cached = false): Promise<AnthropicContentBlock[]> {
  // The taxonomy is DATA, and it arrives in the reader's language — the same names the screen
  // shows and the same names the model is expected to hand back in `clean_name`/`category`.
  // Selecting the raw stored name here would have shown «Продукти» to a reader who sees
  // "Groceries", which is how one concept ends up with two resolutions (see `collectFinanceSnapshot`).
  const loc = await resolveLocale(env);
  const cats = await env.DB.prepare(
    `SELECT id, ${catNameSql(loc, "name")} AS name, is_income FROM categories ORDER BY is_income, id`,
  ).all<{ id: number; name: string; is_income: number }>();
  const taxonomy = (cats.results ?? [])
    .map((c) => `${c.id}: ${c.name}${c.is_income ? " (income)" : ""}`)
    .join("\n");

  const head: AnthropicContentBlock = {
    type: "text",
    text:
      "You are the assistant of a personal finance tracker. You answer with VALID JSON ONLY — no " +
      "explanation, no markdown fence. Amounts are numbers in the currency of the receipt or text " +
      "(not in minor units). " +
      `Task: ${task}.\n\nAvailable categories (id: name):\n${taxonomy}`,
  };

  if (cached) {
    // Стабільний префікс (гайд + приклади) з cache_control — читається з кешу в батчі.
    return [head, { type: "text", text: `${FEW_SHOT}\n\n${CACHE_GUIDE}`, cache_control: { type: "ephemeral", ttl: "1h" } }];
  }
  // Лін: без cache_control (малий префікс однаково не кешується, тож не платимо write-премію).
  return [head, { type: "text", text: FEW_SHOT }];
}

// ⚠️ The merchant strings stay exactly as they are: they are DATA — real descriptions as they
// arrive from the bank, in the alphabet the bank writes them in. Only the instructions around
// them are English. Category ids are named rather than quoted, because the taxonomy above now
// arrives in the reader's language and a hardcoded «Продукти» would name nothing on an English
// screen. `id` is the stable thing here, so the id is what the examples point at.
const FEW_SHOT = `Examples of good categorisation (pick category_id from the list above; the ids
named here are the seed ones and may differ — always match by meaning against the list):
- "кава 45 аромакава" -> a drink at a coffee shop -> the cafés & restaurants category (2)
- "АТБ 247.30" -> a grocery shop -> the groceries category (1)
- "uber 120" -> a ride -> the transport category (3)
- "netflix 199" -> a streaming service -> the streaming category (42)
- "аптека 89" -> medicine -> the health category (4)
- "нова пошта 70" -> a delivery -> the catch-all other category (14)
- "wog 900" -> refuelling -> the transport category (3)
- "сільпо 512" -> groceries -> the groceries category (1)
If the category is unclear, set category_guess to the nearest one; never invent a new category.`;

// The large STABLE guide for the cached prefix (cached=true in buildSystemPrefix).
// Two purposes: (1) cross Haiku's 4096-token cache minimum so bulk enrich reads from cache;
// (2) genuinely improve categorisation (detailed hints plus many real Ukrainian merchants).
// Keep it stable — any edit invalidates the cache, so change it only deliberately.
//
// ⚠️ MERCHANT NAMES ARE DATA and stay exactly as written, in whatever alphabet the bank uses:
// they are matched against real descriptions. Categories are anchored by ID rather than by name,
// because the taxonomy in `buildSystemPrefix` now arrives in the reader's language — a hardcoded
// «Продукти» would name nothing on an English screen.
const CACHE_GUIDE = `DETAILED CATEGORY GUIDE (pick the most precise id; subcategories are fine, they roll up into the parent). Category names below are the seed labels for orientation only — always resolve against the id list in the task prompt.

EXPENSES — the main categories and when to choose them:
- Groceries (1): any grocery shop or supermarket. Subcategories: Supermarket (30) — АТБ, Сільпо, Ашан, Novus, Metro, Varus, Fora, Таврія; Market (31) — open-air markets, «базар», produce bought from a stall. A supermarket chain goes to Supermarket (30); a small corner shop to Groceries (1).
- Cafés & restaurants (2): food and drink away from home. Subcategories: Coffee (32) — coffee shops, «coffee», аромакава, Blur, Львівська майстерня кави, a takeaway cup; Restaurants (33) — full venues, lunch or dinner, McDonald's, KFC, sushi, pizzerias; Food delivery (34) — Glovo, Bolt Food, Rocket, Menu, food ordered to the door. A bar meal or alcohol at a venue goes to Restaurants (33).
- Transport (3): getting around. Subcategories: Taxi (35) — Uber, Bolt, Uklon, Opti; Fuel (36) — WOG, OKKO, UPG, SOCAR, Shell, АЗС, refuelling; Public transport (37) — metro, bus, маршрутка, trolleybus, e-ticket, topping up a transit card. Car sharing and car rental go to Transport (3). Нова пошта and Укрпошта are delivery → Other (14), not Transport.
- Health (4): medicine. Subcategories: Pharmacy (40) — pharmacies, medication, «pharmacy», Аптека доброго дня, Подорожник, ANC; Doctor (41) — clinics, lab tests, dentists, Dobrobut, Сінево, Медіком, consultations. Optics and glasses go to Health (4).
- Clothing & shoes (5): clothes, footwear, accessories — Zara, H&M, Reserved, Intertop, LC Waikiki, Sinsay, shoes, bags.
- Entertainment (6): leisure. Subcategories: Cinema (38) — cinemas, Multiplex, Планета Кіно, film tickets; Games (39) — Steam, PlayStation, Xbox, in-game purchases, game donations. Concerts, bowling, escape rooms and a bar visit for drinks alone go to Entertainment (6).
- Utilities & connectivity (7): utilities, internet, mobile — Київстар, Vodafone, lifecell, Київенерго, gas, water, electricity, ОСББ, intercom, Ланет, Воля, internet providers.
- Home & household (8): household goods, hardware, furniture, repairs, cleaning products — JYSK, IKEA, Епіцентр, Нова лінія, Comfy (for the home), decor, tableware, light bulbs, cleaning supplies.
- Electronics (9): gadgets and appliances — Rozetka, Comfy, Foxtrot, Allo, Apple, phones, laptops, headphones, chargers, tech accessories.
- Beauty & care (10): beauty — hairdresser, barber, manicure, cosmetics, EVA, Watsons, Prostor, perfume, spa, beautician.
- Travel (11): trips — flights, hotels, Booking, Airbnb, hostels, Укрзалізниця intercity trains, tours, accommodation in another city.
- Streaming (42, under Entertainment): Netflix, Spotify, YouTube Premium, MEGOGO, Apple Music, Disney+.
- Software & cloud (43): Anthropic, OpenAI/ChatGPT, Claude, Cloudflare, GitHub, Google One, iCloud, Adobe, Notion, hosting, domains, VPN.
  ⚠️ There is NO "subscriptions" category (§SUBS-CAT, removed 2026-09-02): file by WHAT the money bought, never by the fact that it repeats. Whether a charge is recurring is a property of the operation (planned_id), and the app tracks it separately — a category of that name competed with these two for the same rows and nothing decided between them.
- Education (19): learning — courses, Prometheus, Coursera, Udemy, tutors, textbooks, university, language schools, workshops.
- Children (20): children's spending — toys, children's clothes, nursery, clubs, nappies, baby food, Antoshka.
- Pets (21): pets — pet shops, food, vets, Masterzoo, pet supplies.
- Sports & fitness (22): sport — gym membership, Sport Life, sports nutrition, Decathlon, equipment, swimming pool, yoga.
- Gifts (23): gifts for others — flowers, souvenirs, gift sets, "for a birthday".
- Taxes (24): taxes and state fees. Subcategories: Single tax (25) — ЄП for sole proprietors; Social contribution (26) — ЄСВ; Military levy (27); Personal income tax (28) — ПДФО. «Сплата податку», «ЄП», «ЄСВ», казначейство and ДПС all belong here.
- Home & household vs Electronics: household appliances (a vacuum cleaner, a kettle) depend on context — small household items → Home & household (8), gadgets → Electronics (9).
- Transfers & withdrawals (13): ATM cash withdrawals, transfers to a card or between the user's own accounts, topping up a jar, card-to-card. Do NOT guess the real category in the main field here — leave it in bucket 13.
- Other (14): delivery (Нова пошта, Укрпошта, Meest), post, unclassified items, one-off odds and ends with no clear category, fines, bank fees.

INCOME:
- Salary (15): regular salary, advance payment.
- Freelance (16): payment for work or services, invoices, Upwork, Deel, Payoneer payouts for work.
- Refund (17): money returned, a refund, a cancelled purchase.
- Sale (44): selling things — OLX, Prom, selling one's own property.
- Cashback (45): bank cashback, bonuses, a percentage returned.
- Interest (46): interest on a balance, deposits, accrued interest.
- Gift (47): money received as a gift from someone.
- Other income (18): anything not covered by the other income categories.

MORE EXAMPLES (raw description -> reasoning -> category id):
- "ATB 320.50" -> the АТБ supermarket -> Supermarket (30)
- "SILPO" -> the Сільпо supermarket -> Supermarket (30)
- "NOVUS" -> a supermarket -> Supermarket (30)
- "WOG 1200" -> refuelling -> Fuel (36)
- "OKKO FUEL" -> refuelling -> Fuel (36)
- "BOLT" -> a taxi ride -> Taxi (35)
- "UKLON" -> a taxi -> Taxi (35)
- "GLOVO" -> food delivery -> Food delivery (34)
- "BOLT FOOD" -> food delivery -> Food delivery (34)
- "MCDONALDS" -> fast-food restaurant -> Restaurants (33)
- "KFC" -> fast food -> Restaurants (33)
- "aromakava" -> a coffee shop -> Coffee (32)
- "lviv coffee" -> a coffee shop -> Coffee (32)
- "NETFLIX.COM" -> streaming -> Streaming (42)
- "SPOTIFY" -> a music subscription -> Streaming (42)
- "YOUTUBEPREMIUM" -> a subscription -> Streaming (42)
- "ANTHROPIC" -> an AI service subscription -> Software & cloud (43)
- "OPENAI" -> an AI service -> Software & cloud (43)
- "CLOUDFLARE" -> cloud and hosting -> Software & cloud (43)
- "GITHUB" -> a developer service -> Software & cloud (43)
- "GOOGLE ONE" -> cloud storage -> Software & cloud (43)
- "APTEKA ANC" -> a pharmacy -> Pharmacy (40)
- "SINEVO" -> a testing laboratory -> Doctor (41)
- "DOBROBUT" -> a clinic -> Doctor (41)
- "ROZETKA" -> tech marketplace -> Electronics (9)
- "COMFY" -> tech -> Electronics (9)
- "EPICENTR" -> household goods -> Home & household (8)
- "JYSK" -> home goods -> Home & household (8)
- "ZARA" -> clothes -> Clothing & shoes (5)
- "SINSAY" -> clothes -> Clothing & shoes (5)
- "EVA" -> cosmetics and care -> Beauty & care (10)
- "WATSONS" -> personal care -> Beauty & care (10)
- "KYIVSTAR" -> mobile and internet -> Utilities & connectivity (7)
- "VODAFONE" -> mobile -> Utilities & connectivity (7)
- "STEAM" -> games -> Games (39)
- "PLAYSTATION" -> games -> Games (39)
- "MULTIPLEX" -> cinema -> Cinema (38)
- "BOOKING.COM" -> a hotel -> Travel (11)
- "UZ KVYTKY" -> an intercity rail ticket -> Travel (11)
- "MASTERZOO" -> a pet shop -> Pets (21)
- "SPORTLIFE" -> a gym -> Sports & fitness (22)
- "ANTOSHKA" -> children's goods -> Children (20)
- "PROMETHEUS" -> online courses -> Education (19)
- "Сплата ЄП" -> the single tax -> Single tax (25)
- "ЄСВ ФОП" -> the social contribution -> Social contribution (26)
- "Військовий збір" -> a tax -> Military levy (27)
- "Нова Пошта" -> delivery -> Other (14)
- "Зняття готівки ATM" -> cash -> Transfers & withdrawals (13)
- "Переказ на картку" -> card-to-card -> Transfers & withdrawals (13)
- "На банку" -> topping up the user's own jar -> Transfers & withdrawals (13)
If a merchant is unknown, pick the closest category by meaning and never invent a new one; when it is genuinely ambiguous, use Other (14).`;

// P3.4/§12.5: make USER-FACING free-text answers come back in the right language. Structured
// tasks (enrich/OCR/parse) intentionally do NOT use this — their output is ids, and the numeric
// guard (`numbersAreGrounded`) is language-independent.
//
// Two modes, because the two situations have DIFFERENT right answers (B6, 2026-07-26):
//
//   "content"      — generated text with no user utterance to answer (advice, report, insight,
//                    feed observations). The app locale is the only signal, so it wins.
//   "conversation" — the user just wrote a message. Their language wins; the locale is only the
//                    fallback for something too short to judge.
//
// Why the split is not cosmetic: the single old rule ("write everything in English, do NOT reply
// in Ukrainian") was applied to the chat as well. A visitor running the English UI asked a
// question IN UKRAINIAN, and the model — told to avoid both the user's language and its own
// Ukrainian prompt — answered in RUSSIAN, mid-reply, having found a third Slavic language that
// broke neither instruction literally. Hence also the explicit ban below: it is stated in BOTH
// modes, including `uk`, which previously carried no language instruction at all.
const NEVER_RUSSIAN =
  " Never answer in Russian under any circumstances — not a sentence, not a clause, not even if " +
  "the user writes to you in Russian (in that case answer in Ukrainian).";

export async function replyLangDirective(env: Env, mode: "content" | "conversation" = "content"): Promise<string> {
  const en = (await resolveLocale(env)) === "en";

  if (mode === "conversation") {
    // ⚠️ "the instructions above are written in Ukrainian … that is not a signal" is not padding.
    // Every prompt around this one is Ukrainian prose, and an English question kept coming back
    // in Ukrainian: the model read the language of its own instructions as the language of the
    // job. The prompts no longer NAME a language (that fix is in `tasks.ts`/`report.ts`), but
    // they are still written in one, so the pull has to be denied out loud.
    return " 🌐 RESPONSE LANGUAGE (this overrides everything above and is decided per message): reply in " +
      "the SAME language the user wrote their LATEST message in — Ukrainian question, Ukrainian answer; " +
      "English question, English answer. The instructions above are written in Ukrainian for internal " +
      "reasons; that is NOT a signal about the answer's language and must be ignored when choosing it. " +
      `If the latest message is too short to tell, use ${en ? "English" : "Ukrainian"}. ` +
      "Never mix two languages inside one reply." + NEVER_RUSSIAN;
  }

  return (en
    ? " 🌐 RESPONSE LANGUAGE (overrides any Ukrainian wording above — the instructions are written in " +
      "Ukrainian for internal reasons and say nothing about the answer): write EVERYTHING the user reads " +
      "— headlines, advice, labels, section titles, chart/table captions — in natural English. Keep JSON " +
      "keys and enum values (e.g. 'pos'/'neg', 'info'/'warn') exactly as specified; translate only " +
      "human-readable text. Do NOT reply in Ukrainian."
    : " 🌐 RESPONSE LANGUAGE: write everything the user reads in natural Ukrainian.") + NEVER_RUSSIAN;
}

/**
 * WHICH CURRENCY THE MODEL IS LOOKING AT (§BASE-CUR) — the money half of `replyLangDirective`.
 *
 * Every figure in an AI payload is already rolled up into ONE unit, and that unit is now the
 * reader's choice rather than the hryvnia. Nothing in the payload says so: the field names still
 * end in `_uah` (they are inside every stored report, so they cannot be renamed), and the model
 * reads a key name as a fact. Left alone it writes "₴" over dollar amounts — the same class of
 * defect as §LANG-ARCH, and just as invisible, because the sentence reads perfectly.
 *
 * Deliberately ONE short paragraph placed with the language directive, in the DYNAMIC block: it
 * must not split the 1h prompt cache that the knowledge corpus depends on.
 *
 * ⚠️ **It also states the SCALE, and until 2026-08-27 it stated it WRONGLY** (§0a). The sentence
 * said "minor units" while every payload it accompanies is in WHOLE units — `collectFinanceSnapshot`
 * divides by 100 (`own_funds_uah`, `monthly_burn_uah`, `budgets[].limit_uah`, …), and so do the chat
 * tools (`Math.round(r.amt / 100)`). A model handed a general instruction and a specific field
 * believes the field — which is the reasoning this directive was written from — so here the
 * INSTRUCTION was the false half, and a model that obeyed it understated everything 100×: 12 500 ₴
 * of rent read as ₴125. Invisible in review, because both readings are plausible sentences about
 * money and the model often sanity-checks its way back — which made it intermittent, not absent.
 * Pinned by `worker/test/ai-units.test.ts`: the claim is checked against a real snapshot.
 */
export async function moneyUnitDirective(env: Env): Promise<string> {
  const { resolveBaseCurrency } = await import("../finance/money.ts");
  const { currencyCode, currencySign } = await import("../../../shared/currency.ts");
  const base = await resolveBaseCurrency(env);
  return ` 💱 CURRENCY AND UNITS: every money figure in the data you were given is already converted ` +
    `into ${currencyCode(base)} and is stated in WHOLE units, never in cents — a value of 12500 ` +
    `means 12 500 ${currencySign(base)}, not 125. Fields whose name ends in "_uah" are a historical ` +
    `suffix and do NOT mean hryvnia. Write amounts with "${currencySign(base)}" and never name or ` +
    `convert into another currency, unless a single transaction states its own currency alongside ` +
    `the amount.`;
}

/**
 * Language for a structured answer where exactly ONE field is prose.
 *
 * `replyLangDirective("content")` is too broad for the enrichment calls: their output is data —
 * category ids, `kind`, and `clean_name`, which is a PROPER NOUN and must never be translated
 * («SILPO» stays «Silpo»). But one field, `note`, becomes `transactions.ai_note` and is shown
 * under the operation, so an English-speaking user was reading a Ukrainian sentence on every
 * purchase. Naming the field is what keeps the rest untouched.
 */
export async function langNoteDirective(env: Env): Promise<string> {
  const en = (await resolveLocale(env)) === "en";
  return en
    ? " 🌐 LANGUAGE: `note` is the only field a human reads — write it in natural English. " +
      "Everything else (ids, `kind`, `clean_name`) is data: leave it exactly as specified, and " +
      "never translate or transliterate a brand name." + NEVER_RUSSIAN
    : " 🌐 МОВА: поле `note` читає людина — пиши його українською. Решта полів — дані: " +
      "ids, `kind` і `clean_name` лишай як є, назву бренду не перекладай." + NEVER_RUSSIAN;
}
