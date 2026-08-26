/**
 * §MCP-OAUTH — the consent screen's strings.
 *
 * Split out of `i18n.ts` for the same reason `i18n-tg.ts` was: that file is at the C3 ceiling, and
 * these are the only entries in the whole server dictionary that are PROSE rather than labels — a
 * page of it, describing what someone is about to hand over. Grouping them keeps a paragraph from
 * being edited as if it were a chart legend.
 *
 * Spread into `S` in `i18n.ts`, so `st()` and the key type still have exactly one source.
 */
export const CONSENT = {
  // The only full PAGE the worker renders, so unlike everything else here these are prose. The
  // wording has one job: make it possible to refuse. A consent screen that describes the grant
  // vaguely is worse than none — it collects a click that means nothing.
  consentTitle: { uk: "Дати доступ до фінансів?", en: "Grant access to your finances?" },
  consentIntro: {
    uk: "«{client}» просить доступ до твого Money Track від твого імені.",
    en: "\u201c{client}\u201d is asking for access to your Money Track on your behalf.",
  },
  consentGrants: {
    uk: "Що зможе робити: читати операції, суми, категорії, бюджети, підписки й цілі.",
    en: "What it will be able to do: read your operations, amounts, categories, budgets, subscriptions and goals.",
  },
  consentReadOnly: {
    uk: "Чого не зможе: змінювати чи видаляти будь-що, бачити банківські токени й ключі.",
    en: "What it will not be able to do: change or delete anything, or see your bank tokens and API keys.",
  },
  consentAccount: { uk: "Акаунт: {email}", en: "Account: {email}" },
  // RFC 9728 / the MCP spec both require the redirect host to be visible: it is the one field
  // that says WHERE the code is about to be sent, and it is the field an attacker controls.
  consentRedirect: { uk: "Код буде надіслано на: {host}", en: "The code will be sent to: {host}" },
  consentLoopback: {
    uk: "⚠️ Це адреса на цьому ж компʼютері. Підтверджуй лише якщо ти щойно сам почав підключення — будь-яка програма на цій машині може представитись так само.",
    en: "\u26a0\ufe0f This is an address on this very computer. Approve only if you started this connection yourself just now \u2014 any program on this machine can claim the same address.",
  },
  consentApprove: { uk: "Дозволити", en: "Allow" },
  consentDeny: { uk: "Відхилити", en: "Deny" },
  consentExpired: {
    uk: "Термін цього запиту минув. Почни підключення в застосунку заново.",
    en: "This request has expired. Start the connection again from the app.",
  },
} as const;
