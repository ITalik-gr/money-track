/**
 * Where the money is in a sentence the model wrote. Pure (no React, no locale) so the worker test
 * runner can pin it: every miss here is visible only as a half-highlighted figure in a live answer.
 *
 * A range is ONE span. The previous pattern matched a number directly followed by a unit, so
 * «26 000–32 500₴» lit up only its second half and read as two unrelated values.
 *
 * Thousands are grouped strictly in threes. The old `\d[\d\s]*` swallowed any digits before a
 * space, so «у 2026 120 ₴» became one amount of 2 026 120.
 */
// A comma group counts only when it cannot be a decimal: «$2,162.84» or «1,200,000», never «1,125».
const NUM = String.raw`[1-9]\d{0,2}(?:,\d{3})+\.\d{1,8}|[1-9]\d{0,2}(?:,\d{3}){2,}(?:\.\d{1,8})?|\d{1,3}(?:[   ]\d{3})+(?:[.,]\d{1,8})?|\d+(?:[.,]\d{1,8})?`;
// «к» only when glued to the digits: a spaced one is the Ukrainian preposition.
const SCALE_WORD = String.raw`(?:\s?(?:тис\.?|млн|млрд|k|K|M)|к)(?![\p{L}\d])`;
const SCALE = `(?:${SCALE_WORD})?`;
const UNIT = String.raw`₴|грн\.?|UAH|\$|USDT|USDC|USD|€|EUR|£|GBP|zł|PLN|BTC|ETH|SOL|BNB|TON|XRP|%|в\.п\.`;
// Signs that may stand before the number; the hryvnia comes from the one match-key list above.
const PRE = `[$€£${UNIT[0]}]`;
const DASH = String.raw`\s?[-–—]\s?`;
const VALUE = `(?:${NUM})${SCALE}`;
// Currency-first («$1 200–1 500») is tried before number-first so the sign stays inside the span.
const AMOUNT_RE = new RegExp(
  String.raw`(?<![\p{L}\d.,])(?:[+−]|(?<=^|[\s(])-)?(?:` +
    String.raw`(?<pre>${PRE})\s?(?<a>${VALUE})(?:${DASH}(?:${PRE}\s?)?(?<b>${VALUE}))?` +
    String.raw`|(?<c>${VALUE})(?:\s?(?<mid>${UNIT}))?${DASH}(?<d>${VALUE})\s?(?<u1>${UNIT})(?![\p{L}\d])` +
    String.raw`|(?<e>${VALUE})\s?(?<u2>${UNIT})(?![\p{L}\d])` +
    // People and the model write money with no unit at all: «5-6к», «~31-37 тис».
    `|(?:(?:${NUM})${DASH})?(?:${NUM})${SCALE_WORD}` +
    `)`,
  "gu",
);

export type AmountSegment = { text: string; amount: boolean };

/** Regroups each number through `fmt`, leaving units, scale words and dashes as the model wrote them. */
export function splitAmounts(text: string, fmt: (raw: string) => string): AmountSegment[] {
  const out: AmountSegment[] = [];
  const numbers = new RegExp(NUM, "gu");
  let last = 0;
  for (const m of text.matchAll(AMOUNT_RE)) {
    const at = m.index;
    if (at > last) out.push({ text: text.slice(last, at), amount: false });
    out.push({ text: m[0].replace(numbers, fmt), amount: true });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), amount: false });
  return out;
}
