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
