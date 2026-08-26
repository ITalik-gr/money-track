/**
 * Is a number the model wrote a number the model was GIVEN?
 *
 * Moved out of `lib/messaging/notify.ts` on 2026-08-21, unchanged. It was written for the feed
 * after the model produced two different figures for the same thing inside one notification, and
 * `CLAUDE.md` states the rule it bought in general terms: **if a number from the AI reaches the
 * UI, a deterministic check stands beside it.** The guard then stayed where it was born, guarding
 * one surface — while `structured.facts[].amount`, which the model also authors, goes straight
 * onto the Advisor card and into the weekly Telegram digest with nothing between it and the eye.
 *
 * A rule applied to the place it was discovered and not to its siblings is the same shape as every
 * other finding of that day; this file exists so the guard has no home surface.
 */
export function collectNumbers(v: unknown, out: Set<number>, depth = 0): void {
  if (depth > 6 || out.size > 5000) return;
  if (typeof v === "number") { if (Number.isFinite(v)) out.add(Math.abs(v)); return; }
  if (typeof v === "string") { const n = Number(v.replace(",", ".")); if (v.trim() && Number.isFinite(n)) out.add(Math.abs(n)); return; }
  if (Array.isArray(v)) { for (const x of v) collectNumbers(x, out, depth + 1); return; }
  if (v && typeof v === "object") { for (const x of Object.values(v)) collectNumbers(x, out, depth + 1); }
}

export function numbersAreGrounded(text: string, known: Set<number>): boolean {
  // Пробіли/нерозривні пробіли всередині числа — це розрядні роздільники («3 354»).
  const found = text.match(/\d[\d\s  ]*(?:[.,]\d+)?/g) ?? [];
  for (const raw of found) {
    const n = Math.abs(Number(raw.replace(/[\s  ]/g, "").replace(",", ".")));
    if (!Number.isFinite(n) || n < 100) continue;
    let ok = false;
    for (const k of known) {
      if (Math.abs(n - k) <= Math.max(1, k * 0.01)) { ok = true; break; }
    }
    if (!ok) return false;
  }
  return true;
}

/**
 * Drop model-authored facts whose AMOUNT was never in the payload.
 *
 * The label and the note are prose and stay as written — the model is asked to interpret, and an
 * interpretation cannot be checked against a set of numbers. The AMOUNT is different: it is
 * rendered as a figure on the Advisor card and in the Telegram digest, where it is indistinguishable
 * from one the app computed.
 *
 * ⚠️ A fact is dropped, not blanked. A fact whose whole content was «Підписки — 3 400 ₴» has
 * nothing left once the figure goes, and «Підписки — » on a card reads as a rendering bug rather
 * than as a fact withheld.
 * ⚠️ Only amounts at or above the same 100 floor the text guard uses: `delta_pct` and small counts
 * are not money, and a percentage that happens not to appear in the payload is not an invention.
 */
export function groundFacts<T extends { amount?: number | null }>(facts: T[], payload: unknown): T[] {
  const known = new Set<number>();
  collectNumbers(payload, known);
  return facts.filter((f) => f.amount == null || numbersAreGrounded(String(f.amount), known));
}

/**
 * Is a DATE or a DAY COUNT the model wrote one it was GIVEN?
 *
 * `numbersAreGrounded` has a floor of 100 on purpose — counts and percentages are not sums, and a
 * guard that rejects «за 7 днів» is a guard everyone removes. That floor left the whole CALENDAR
 * unchecked, and the feed shipped the consequence: «Rent due in 11 days, cushion covers only 0.8
 * months» on 2026-08-26, for rent the user pays on the 20th. The rent is not a `planned_payment` at
 * all, so it was in no `upcoming_charges` row and had no date anywhere in the payload — the model
 * read the user's own prose in `situation` («12500 кожного 20 числа») as a schedule and invented a
 * distance to it. Every figure in that sentence was under 100, so the money guard saw nothing.
 *
 * A wrong day is worse than a wrong sum: a sum can be re-read on the screen beside it, while a
 * deadline is acted on directly, and «in 11 days» for something due in 25 reads as certainty.
 *
 * `anchors` is the set of day numbers the payload actually states (`in_days`, the day-of-month of a
 * scheduled charge, today's day, the window lengths). An EMPTY anchor set rejects every time claim,
 * which is the correct reading of "we told it no schedule".
 */
// ⚠️ `\b` is ASCII-only even under /u, so it never fires after «днів» — the Ukrainian half of
// this pattern silently matched nothing until the test caught it. A letter lookahead works
// in both scripts.
const DAY_COUNT_RE = /(\d{1,3})\s*(?:днів|дні|дня|дн\.|day|days|доби|добу|діб)(?!\p{L})/giu;
const DAY_OF_MONTH_RE = /(?<!\d)(\d{1,2})\s*(?:-?(?:го|те|му|е)|числа|st|nd|rd|th)(?!\p{L})/giu;
/**
 * Month STEMS, index = 0-based month. Matched as a word start (`(?<!\p{L})stem`) so «серп» finds
 * «серпня» and «серпень» without a declension table.
 *
 * ⚠️ English "may" is deliberately absent: it is a modal verb far more often than a month, and a
 * guard that discards every sentence containing "may cost" is a guard someone deletes. The
 * Ukrainian stem for May is kept — «трав» has no such second life in a sentence about money.
 */
const MONTH_WORDS: string[][] = [
  ["january", "січ"], ["february", "лют"], ["march", "берез"], ["april", "квіт"],
  ["трав"], ["june", "черв"], ["july", "лип"], ["august", "серп"],
  ["september", "верес"], ["october", "жовт"], ["november", "листоп"], ["december", "груд"],
];

export function timeClaimsAreGrounded(
  text: string, anchors: Set<number>, months: Set<number>,
): boolean {
  const low = text.toLowerCase();
  for (const re of [DAY_COUNT_RE, DAY_OF_MONTH_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(low))) {
      const n = Number(m[1]);
      // Exact match, no tolerance: 20 and 21 are different days, and "about the 20th" is not a
      // thing anyone acts on differently.
      if (!anchors.has(n)) return false;
    }
  }
  // A month the payload never names is a projection ("your money ends before October"), i.e. a
  // calendar claim computed by eye out of a runway figure.
  for (let i = 0; i < MONTH_WORDS.length; i++) {
    if (months.has(i)) continue;
    if (MONTH_WORDS[i].some((w) => new RegExp(`(?<!\\p{L})${w}`, "u").test(low))) return false;
  }
  return true;
}

/**
 * Does the text read in the language the app asked for?
 *
 * The prompts are English (§LANG-ARCH) and the language is requested by one final directive, so a
 * Ukrainian reader kept getting English TITLES over Ukrainian bodies — one card, two languages,
 * which reads as a broken app rather than as a missing translation. The prompt's own STYLE examples
 * were English headlines, which is a pull no directive outvotes.
 *
 * Script, not vocabulary: a Ukrainian sentence carrying «Claude» and «Spotify» is correct, and a
 * ratio test says so while a word list never could.
 */
export function scriptMatchesLocale(text: string, locale: "uk" | "en"): boolean {
  const cyr = (text.match(/\p{Script=Cyrillic}/gu) ?? []).length;
  const lat = (text.match(/\p{Script=Latin}/gu) ?? []).length;
  if (cyr + lat < 8) return true;              // "PS Plus 350" — too short to have a language
  return locale === "uk" ? cyr > lat : lat > cyr;
}
