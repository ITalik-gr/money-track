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
import { getState } from "../finance/repo.ts";
import type { AnthropicContentBlock } from "./ai.ts";



// Build the system prefix from the live category taxonomy.
// ВАЖЛИВО про кеш (виміряно count_tokens): базовий префікс ≈789 тк, а мінімум кешу
// Haiku 4.5 = 4096 тк — тож cache_control на малому префіксі МОВЧКИ не працює.
// Тому кешування вмикаємо лише коли cached=true (масовий enrich): додаємо великий
// СТАБІЛЬНИЙ гайд (CACHE_GUIDE, також покращує якість) з cache_control, щоб перетнути
// поріг. Поодинокі/інтерактивні виклики лишаємо «лін» (без кешу — малий префікс дешевий).
export async function buildSystemPrefix(env: Env, task: string, cached = false): Promise<AnthropicContentBlock[]> {
  const cats = await env.DB.prepare(
    "SELECT id, name, is_income FROM categories ORDER BY is_income, id",
  ).all<{ id: number; name: string; is_income: number }>();
  const taxonomy = (cats.results ?? [])
    .map((c) => `${c.id}: ${c.name}${c.is_income ? " (дохід)" : ""}`)
    .join("\n");

  const head: AnthropicContentBlock = {
    type: "text",
    text:
      "Ти — асистент персонального фінансового трекера. Відповідаєш ВИКЛЮЧНО валідним JSON, " +
      "без пояснень і без markdown-огорожі. Суми — числом у валюті чека/тексту (не в копійках). " +
      `Задача: ${task}.\n\nДоступні категорії (id: назва):\n${taxonomy}`,
  };

  if (cached) {
    // Стабільний префікс (гайд + приклади) з cache_control — читається з кешу в батчі.
    return [head, { type: "text", text: `${FEW_SHOT}\n\n${CACHE_GUIDE}`, cache_control: { type: "ephemeral", ttl: "1h" } }];
  }
  // Лін: без cache_control (малий префікс однаково не кешується, тож не платимо write-премію).
  return [head, { type: "text", text: FEW_SHOT }];
}

const FEW_SHOT = `Приклади якісної категоризації (обирай category_id з переліку вище):
- "кава 45 аромакава" -> напій у кавʼярні -> Кафе і ресторани
- "АТБ 247.30" -> продуктовий магазин -> Продукти
- "uber 120" -> поїздка -> Транспорт
- "netflix 199" -> підписка на сервіс -> Підписки
- "аптека 89" -> ліки -> Здоровʼя
- "нова пошта 70" -> доставка -> Інше
- "wog 900" -> заправка -> Транспорт
- "сільпо 512" -> продукти -> Продукти
Якщо категорія неясна — став category_guess у найближчу, не вигадуй нову.`;

// Великий СТАБІЛЬНИЙ гайд для кешованого префікса (cached=true у buildSystemPrefix).
// Дві мети: (1) перетнути мінімум кешу Haiku (4096 тк), щоб масовий enrich читав кеш;
// (2) реально підняти якість категоризації (детальні підказки + багато прикладів UA-мерчантів).
// Тримати стабільним (будь-яка зміна інвалідує кеш) — правити лише свідомо.
const CACHE_GUIDE = `ДЕТАЛЬНИЙ ГАЙД ПО КАТЕГОРІЯХ (обирай найточніший id; підкатегорії можна, вони згортаються в батька):

ВИТРАТИ — основні категорії та коли їх обирати:
- Продукти (1): будь-які продуктові магазини й супермаркети. Підкатегорії: Супермаркет (30) — АТБ, Сільпо, Ашан, Novus, Metro, Varus, Fora, Таврія; Ринок (31) — стихійні ринки, «базар», овочі/фрукти з рук. Якщо це мережевий супермаркет — Супермаркет (30); дрібний магазин біля дому — Продукти (1).
- Кафе і ресторани (2): їжа й напої поза домом. Підкатегорії: Кава (32) — кавʼярні, «coffee», аромакава, Blur, Львівська майстерня кави, стакан кави на виніс; Ресторани (33) — повноцінні заклади, обід/вечеря, McDonald's, KFC, суші, піцерія; Доставка їжі (34) — Glovo, Bolt Food, Rocket, Menu, замовлення їжі додому. Барна вечеря/алкоголь у закладі — Ресторани (33).
- Транспорт (3): пересування. Підкатегорії: Таксі (35) — Uber, Bolt, Uklon, Opti; Пальне (36) — WOG, OKKO, UPG, SOCAR, Shell, АЗС, заправка; Громадський (37) — метро, автобус, маршрутка, тролейбус, е-квиток, поповнення транспортної картки. Каршеринг/оренда авто — Транспорт (3). Нова пошта/Укрпошта — це доставка → Інше (14), а не Транспорт.
- Здоровʼя (4): медицина. Підкатегорії: Аптека (40) — аптеки, ліки, «pharmacy», Аптека доброго дня, Подорожник, ANC; Лікар (41) — клініки, аналізи, стоматолог, Dobrobut, Сінево, Медіком, консультації. Оптика/окуляри — Здоровʼя (4).
- Одяг і взуття (5): одяг, взуття, аксесуари — Zara, H&M, Reserved, Intertop, LC Waikiki, Sinsay, взуття, сумки.
- Розваги (6): дозвілля. Підкатегорії: Кіно (38) — кінотеатри, Multiplex, Планета Кіно, квитки на фільм; Ігри (39) — Steam, PlayStation, Xbox, ігрові покупки, донат у грі. Концерти, боулінг, квести, бар «просто випити» — Розваги (6).
- Комуналка і звʼязок (7): комунальні, інтернет, мобільний — Київстар, Vodafone, lifecell, ОТ «Київенерго», газ, вода, світло, ОСББ, домофон, Ланет, Воля, інтернет-провайдер.
- Дім і побут (8): товари для дому, госптовари, меблі, ремонт, побутова хімія — JYSK, IKEA, Епіцентр, Нова лінія, Comfy (для дому), декор, посуд, лампочки, засоби для прибирання.
- Електроніка (9): гаджети й техніка — Rozetka, Comfy, Foxtrot, Allo, Apple, телефон, ноутбук, навушники, зарядка, аксесуари до техніки.
- Краса і догляд (10): б'юті — перукар, барбершоп, манікюр, косметика, EVA, Watsons, Prostor, парфуми, spa, косметолог.
- Подорожі (11): поїздки — авіаквитки, готелі, Booking, Airbnb, hostel, потяг Укрзалізниця (міжміський), тури, оренда житла в іншому місті.
- Підписки (12): регулярні цифрові платежі. Підкатегорії: Стрімінги (42) — Netflix, Spotify, YouTube Premium, MEGOGO, Apple Music, Disney+; Софт і хмара (43) — Anthropic, OpenAI/ChatGPT, Claude, Cloudflare, GitHub, Google One, iCloud, Adobe, Notion, хостинг, домен, VPN. Регулярний однаковий платіж сервісу → Підписки (12).
- Освіта (19): навчання — курси, Prometheus, Coursera, Udemy, репетитор, книги для навчання, університет, мовна школа, воркшопи.
- Діти (20): дитячі витрати — іграшки, дитячий одяг, садок, гуртки, памперси, дитяче харчування, Antoshka.
- Тварини (21): улюбленці — зоомагазин, корм, ветеринар, Masterzoo, засоби для тварин.
- Спорт і фітнес (22): спорт — абонемент у зал, Sport Life, спортивне харчування, Decathlon, інвентар, басейн, йога.
- Подарунки (23): подарунки іншим — квіти, сувеніри, подарункові набори, «на день народження».
- Податки (24): податки й держзбори. Підкатегорії: Єдиний податок (25) — ЄП ФОП; ЄСВ (26) — єдиний соцвнесок; Військовий збір (27); ПДФО (28) — податок з доходів. «Сплата податку», «ЄП», «ЄСВ», казначейство, ДПС — сюди.
- Дім і побут vs Електроніка: побутова техніка для дому (пилосос, чайник) — залежно від контексту, дрібне для дому → Дім і побут (8), гаджети → Електроніка (9).
- Перекази і зняття (13): зняття готівки в банкоматі, перекази на картку/між своїми, поповнення банки, card-to-card. НЕ вгадуй тут реальну категорію в основному полі — лишай бакет 13.
- Інше (14): доставка (Нова пошта, Укрпошта, Meest), пошта, не класифіковане, разові дрібниці без явної категорії, штрафи, комісії банку.

НАДХОДЖЕННЯ:
- Зарплата (15): регулярна зарплата, аванс.
- Фріланс (16): оплата за роботу/послуги, інвойси, Upwork, Deel, Payoneer-виплати за роботу.
- Повернення (17): повернення коштів, рефанд, скасована покупка.
- Продаж (44): продаж речей — OLX, Prom, продаж власного майна.
- Кешбек (45): кешбек банку, бонуси, повернення відсотком.
- Проценти (46): відсотки на залишок, депозит, нараховані проценти.
- Подарунок (47): гроші в подарунок, отримані від когось.
- Інші надходження (18): що не підпадає під інші доходи.

БІЛЬШЕ ПРИКЛАДІВ (сирий опис -> міркування -> категорія id):
- "ATB 320.50" -> супермаркет АТБ -> Супермаркет (30)
- "SILPO" -> супермаркет Сільпо -> Супермаркет (30)
- "NOVUS" -> супермаркет -> Супермаркет (30)
- "WOG 1200" -> заправка пальним -> Пальне (36)
- "OKKO FUEL" -> заправка -> Пальне (36)
- "BOLT" -> поїздка таксі -> Таксі (35)
- "UKLON" -> таксі -> Таксі (35)
- "GLOVO" -> доставка їжі -> Доставка їжі (34)
- "BOLT FOOD" -> доставка їжі -> Доставка їжі (34)
- "MCDONALDS" -> ресторан фастфуд -> Ресторани (33)
- "KFC" -> фастфуд -> Ресторани (33)
- "aromakava" -> кавʼярня -> Кава (32)
- "lviv coffee" -> кавʼярня -> Кава (32)
- "NETFLIX.COM" -> стрімінг -> Стрімінги (42)
- "SPOTIFY" -> музика підписка -> Стрімінги (42)
- "YOUTUBEPREMIUM" -> підписка -> Стрімінги (42)
- "ANTHROPIC" -> AI-сервіс підписка -> Софт і хмара (43)
- "OPENAI" -> AI-сервіс -> Софт і хмара (43)
- "CLOUDFLARE" -> хмара/хостинг -> Софт і хмара (43)
- "GITHUB" -> dev-сервіс -> Софт і хмара (43)
- "GOOGLE ONE" -> хмара -> Софт і хмара (43)
- "APTEKA ANC" -> аптека -> Аптека (40)
- "SINEVO" -> лабораторія аналізів -> Лікар (41)
- "DOBROBUT" -> клініка -> Лікар (41)
- "ROZETKA" -> техніка/маркетплейс -> Електроніка (9)
- "COMFY" -> техніка -> Електроніка (9)
- "EPICENTR" -> товари для дому -> Дім і побут (8)
- "JYSK" -> дім -> Дім і побут (8)
- "ZARA" -> одяг -> Одяг і взуття (5)
- "SINSAY" -> одяг -> Одяг і взуття (5)
- "EVA" -> косметика/догляд -> Краса і догляд (10)
- "WATSONS" -> догляд -> Краса і догляд (10)
- "KYIVSTAR" -> мобільний/інтернет -> Комуналка і звʼязок (7)
- "VODAFONE" -> мобільний -> Комуналка і звʼязок (7)
- "STEAM" -> ігри -> Ігри (39)
- "PLAYSTATION" -> ігри -> Ігри (39)
- "MULTIPLEX" -> кіно -> Кіно (38)
- "BOOKING.COM" -> готель -> Подорожі (11)
- "UZ KVYTKY" -> квиток УЗ міжміський -> Подорожі (11)
- "MASTERZOO" -> зоомагазин -> Тварини (21)
- "SPORTLIFE" -> спортзал -> Спорт і фітнес (22)
- "ANTOSHKA" -> дитячі товари -> Діти (20)
- "PROMETHEUS" -> онлайн-курси -> Освіта (19)
- "Сплата ЄП" -> єдиний податок -> Єдиний податок (25)
- "ЄСВ ФОП" -> єдиний соцвнесок -> ЄСВ (26)
- "Військовий збір" -> податок -> Військовий збір (27)
- "Нова Пошта" -> доставка -> Інше (14)
- "Зняття готівки ATM" -> готівка -> Перекази і зняття (13)
- "Переказ на картку" -> card-to-card -> Перекази і зняття (13)
- "На банку" -> поповнення власної банки -> Перекази і зняття (13)
Якщо мерчант нижче невідомий — став найближчу за змістом категорію, не вигадуй нову; при повній неоднозначності — Інше (14).`;

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
  // Same order as `c.get("locale")`: the reader's current language beats the stored preference,
  // and the stored preference is what cron/Telegram (no request, no header) fall back to.
  const en = (env.UI_LOCALE ?? (await getState(env.DB, "locale"))) === "en";

  if (mode === "conversation") {
    return " 🌐 RESPONSE LANGUAGE (overrides any language wording above): reply in the SAME language " +
      "the user wrote their latest message in — Ukrainian question, Ukrainian answer; English question, " +
      `English answer. If the message is too short to tell, use ${en ? "English" : "Ukrainian"}. ` +
      "Never mix two languages inside one reply." + NEVER_RUSSIAN;
  }

  return (en
    ? " 🌐 RESPONSE LANGUAGE (overrides any Ukrainian wording above): write EVERYTHING the user reads " +
      "— headlines, advice, labels, section titles, chart/table captions — in natural English. Keep JSON " +
      "keys and enum values (e.g. 'pos'/'neg', 'info'/'warn') exactly as specified; translate only " +
      "human-readable text. Do NOT reply in Ukrainian."
    : " 🌐 RESPONSE LANGUAGE: write everything the user reads in natural Ukrainian.") + NEVER_RUSSIAN;
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
  const en = (env.UI_LOCALE ?? (await getState(env.DB, "locale"))) === "en";
  return en
    ? " 🌐 LANGUAGE: `note` is the only field a human reads — write it in natural English. " +
      "Everything else (ids, `kind`, `clean_name`) is data: leave it exactly as specified, and " +
      "never translate or transliterate a brand name." + NEVER_RUSSIAN
    : " 🌐 МОВА: поле `note` читає людина — пиши його українською. Решта полів — дані: " +
      "ids, `kind` і `clean_name` лишай як є, назву бренду не перекладай." + NEVER_RUSSIAN;
}
