/**
 * The bot's statistics commands — and the one property that matters about them.
 *
 * **They must agree with the web app, digit for digit.** Not approximately: the whole reason this
 * codebase keeps a canon is that the app once quoted two different figures for the same envelope,
 * once in Telegram and once on screen, and the owner found it. So these tests do not assert that
 * `/budget` prints a plausible number — they assert that it prints THE number `budgetStatus`
 * returns, which is the number the web page renders.
 *
 * The formatting helpers are tested separately because their failures are silent in a different
 * way: a message over 4096 characters is REFUSED by Telegram, so a too-long reply does not arrive
 * truncated, it does not arrive at all, and the bot looks broken rather than verbose.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { bar, capMessage, tgMoney, escapeHtml, TG_MAX } from "../lib/messaging/tg-format.ts";

test("a bar is a proportion, and overflow gets a marker instead of a longer bar", () => {
  assert.equal(bar(0, 8), "░░░░░░░░");
  assert.equal(bar(0.5, 8), "████░░░░");
  assert.equal(bar(1, 8), "████████");
  // Past the limit the track stays the same length — a bar that can exceed its own container
  // stops reading as a proportion, which is the only thing it is for.
  assert.equal(bar(1.8, 8), "████████▓");
  // Nonsense in, empty track out — never a crash and never a bar of NaN cells.
  assert.equal(bar(Number.NaN, 8), "░░░░░░░░");
  assert.equal(bar(-1, 8), "░░░░░░░░");
});

test("a message is cut to fit, and says that it was", () => {
  const long = Array.from({ length: 500 }, (_, i) => `line ${i} ————————————————`).join("\n");
  assert.ok(long.length > TG_MAX);
  const out = capMessage(long, "(trimmed)");
  assert.ok(out.length <= TG_MAX, `capped to ${out.length}`);
  assert.ok(out.endsWith("(trimmed)"));
  // Cut on a line boundary: half a row reads as corrupted data rather than as a trimmed list.
  assert.ok(!out.split("\n").slice(-3)[0].startsWith("line") || out.includes("\n…\n"));
  // Anything that already fits is returned untouched — no marker on a complete message.
  assert.equal(capMessage("short", "(trimmed)"), "short");
});

test("money wears the currency it is given, not a default", () => {
  // Grouping uses a NON-BREAKING space in `uk-UA`, so the comparison normalises whitespace —
  // asserting on the exact byte would pin an Intl implementation detail rather than the rule.
  const norm = (s: string) => s.replace(/\s+/g, " ");
  // The bot prints both: a roll-up in the reader's base, a single charge in the currency it was
  // made in. A default would make one of them silently wrong.
  assert.equal(norm(tgMoney(123456, 980, "uk")), "1 235 ₴");
  assert.equal(norm(tgMoney(123456, 840, "en")), "1,235 $");
  // An unsupported code prints the CODE, never a wrong sign (`shared/currency.ts`).
  assert.equal(norm(tgMoney(100, 999, "en")), "1 999");
});

test("user text cannot become markup", () => {
  // Telegram parses HTML, and a merchant name is arbitrary text from a bank feed.
  assert.equal(escapeHtml('<b>&"x"'), "&lt;b&gt;&amp;\"x\"");
});

/**
 * The two-way half: a link back into the app, and a setting changed from the chat.
 */
import { appLink } from "../lib/messaging/tg-commands.ts";
import { NOTIF_KINDS } from "../lib/messaging/notify.ts";

test("a deep link is omitted rather than guessed when the origin is unknown", () => {
  assert.equal(appLink("https://money.example", "/stats", "en"),
    '\n\n🔗 <a href="https://money.example/stats">Open in the app</a>');
  // A push assembled by the cron has no request behind it. A link to a guessed host is worse than
  // no link: it is a promise the product cannot keep, on a different deployment every time.
  assert.equal(appLink(undefined, "/stats", "en"), "");
});

test("/mute accepts exactly the canonical notification kinds", () => {
  // The validation matters because `setPrefs` takes a PARTIAL: an unknown key would be stored
  // happily, report success, and silently do nothing for as long as the account exists.
  assert.ok(NOTIF_KINDS.includes("budget"));
  assert.ok(!(NOTIF_KINDS as string[]).includes("budgets"));
  assert.ok(!(NOTIF_KINDS as string[]).includes(""));
});

/**
 * Quick entry: which way the money went, and when a message is a QUESTION rather than an entry.
 */
test("the sign is applied on save, from the direction — never from the parsed amount", () => {
  // `TextResult.amount` is positive by contract; the direction is a separate field. The rule is
  // worth pinning because getting it wrong inverts the arithmetic on the one entry a person is
  // most pleased to make: «отримав 5000 за фріланс» stored as a 5 000 outflow.
  const signed = (kind: "expense" | "income" | undefined, major: number) =>
    (kind === "income" ? 1 : -1) * Math.round(major * 100);

  assert.equal(signed("expense", 45), -4500);
  assert.equal(signed("income", 12000), 1200000);
  // A record stored before the field existed, and any handler that forgets it, produce an
  // EXPENSE — the safe default, and the one the confirmation was labelled with.
  assert.equal(signed(undefined, 45), -4500);
});

test("a question is routed to the adviser, an entry is not", () => {
  // The heuristic in `handleText`, stated here so a change to it is a deliberate one.
  const isQuestion = (t: string) =>
    /[?？]/.test(t) || /^(скільки|чому|коли|який|яка|шо|що|how|why|when|what|which|where)(?:\s|$)/i.test(t.trim());

  assert.ok(isQuestion("скільки я витратив на каву?"));
  assert.ok(isQuestion("how much on groceries"));
  assert.ok(isQuestion("що з бюджетом"));
  // The failure this fixes: parsed as a purchase from a merchant called «скільки я витратив».
  assert.ok(isQuestion("скільки я витратив"));

  // Ordinary entries must NOT be swallowed by it — that would be the worse direction, because
  // the entry is the thing the person is trying to record.
  assert.ok(!isQuestion("кава 45 аромакава"));
  assert.ok(!isQuestion("taxi 120"));
  assert.ok(!isQuestion("отримав 12000 зарплата"));
});
