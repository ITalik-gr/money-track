/**
 * docs/JEV.md phase 4 — what a merchant IS, as the reason shown beside a §SUB-REVIEW verdict.
 *
 * With Claude the reason was a sentence the model wrote. Jev does not write; it picks one of these
 * types, and the screen shows the type's label. That trade is deliberate: a label from OUR list is
 * always in the reader's language, never says something the app cannot stand behind, and cannot
 * carry text a merchant name smuggled in (docs/JEV.md §8, adversarial content).
 *
 * Spread into `S` in `i18n.ts`, so `st()` and the key type still have exactly one source. Split out
 * for the same reason as `i18n-consent.ts`: `i18n.ts` sits at its C3 ceiling.
 */
export const JUDGE = {
  merchStreaming: { uk: "стрімінговий сервіс", en: "a streaming service" },
  merchSoftware: { uk: "софт або хмарний сервіс", en: "software or a cloud service" },
  merchTelecom: { uk: "мобільний звʼязок або інтернет", en: "mobile or internet" },
  merchUtility: { uk: "комунальні платежі або сервіс оплати рахунків", en: "utilities or a bill-payment service" },
  merchMembership: { uk: "абонемент (спортзал, клуб)", en: "a membership (gym, club)" },
  merchInsurance: { uk: "страхування", en: "insurance" },
  merchRent: { uk: "оренда житла", en: "rent" },
  merchDeliveryPlan: { uk: "регулярна доставка за планом", en: "a delivery plan" },
  merchGrocery: { uk: "продуктовий магазин", en: "a grocery shop" },
  merchCafe: { uk: "кафе чи ресторан", en: "a café or restaurant" },
  merchTransport: { uk: "транспорт або таксі", en: "transport or a taxi" },
  merchShop: { uk: "магазин або маркетплейс", en: "a shop or a marketplace" },
  merchPharmacy: { uk: "аптека", en: "a pharmacy" },
  merchPost: { uk: "пошта або доставка посилок", en: "post or parcel delivery" },
  merchUnclear: { uk: "з назви не зрозуміло", en: "not clear from the name" },
} as const;
