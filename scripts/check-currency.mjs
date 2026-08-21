#!/usr/bin/env node
/**
 * C10 — there is ONE conversion target, and it is the reader's currency (§BASE-CUR).
 *
 * Two rules, both bought by the same class of bug that C1 exists for:
 *
 *  1. **`getStoredRates` is not for reading money onto a screen.** It returns the table as the
 *     bank published it — hryvnia per unit — and the app now converts into whatever base the
 *     reader chose. A caller that reaches for the stored map gets a number that is right for one
 *     user and 41× wrong for the next, and nothing about the call site looks unusual. Only the
 *     re-expression itself and the rate snapshotter may touch it.
 *
 *  2. **A hryvnia sign is not a literal in worker code.** The symbol comes from
 *     `shared/currency.ts` — through `st()` params in the deterministic advice, through
 *     `notif-i18n` in the feed, through `tgMoney()` in the bot. The Telegram surface WAS exempt on
 *     the grounds of being owner-only; §D1 ended that on 2026-08-01 and the exemption was finally
 *     removed on 2026-08-21 — see the note on HRYVNIA_OK below, which is the general lesson.
 *
 * WHY A CHECK. The whole feature works by making the OLD call sites right without touching them
 * (`getRates` kept its name and its return type). That is what made it possible at all, and it is
 * exactly what makes a regression invisible: the wrong version compiles, runs, and renders a
 * plausible number. `tsc` cannot tell two `Record<string, number>` maps apart.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = "worker";

/**
 * CLIENT RULES — the half the API sweep cannot see.
 *
 * `worker/test/currency-sweep.test.ts` proves every number LEAVING the server is in the reader's
 * base. It says nothing about the sign printed next to it, and that is where the reported bug
 * actually lived: one `currencySign(currency ?? 980)` in `Stats.tsx` is threaded into thirteen
 * blocks, so all five Statistics tabs printed ₴ over dollar figures. Two more components asked
 * `/analytics/overview` for `currency: 980`, which does not mean "show hryvnia" — it PINS the
 * query to hryvnia rows and stops converting, so those cards had been dropping foreign spending
 * since long before this feature existed.
 *
 * Each pattern below is one of those mistakes, generalised. The literal 980 is the tell: it is
 * only ever written down when someone means "the unit everything rolls up into", and that is now
 * a setting, not a constant.
 */
const CLIENT_ROOTS = ["src", "shared"];
const CLIENT_RULES = [
  {
    re: /currencySign\(\s*\d{3}\s*\)|currencySign\([^)]*\?\?\s*\d{3}\s*\)/,
    say: "a currency code literal in a sign call. Rolled-up money has no fixed currency — use baseSign(), or signFor(cur) when the value MAY carry its own.",
  },
  {
    re: /currency:\s*980|currency=\{980\}/,
    say: "asks an endpoint for currency 980. That does not select a unit, it FILTERS to hryvnia rows and stops converting — pass null for a rolled-up figure.",
  },
  {
    re: /[!=]==\s*980|980\s*[!=]==/,
    say: "compares a currency against 980 to decide whether to convert or to show an equivalent. The question is 'is this the unit the screen totals in' — compare against getBaseCurrency().",
  },
];

/** Lines where a hryvnia literal is the SUBJECT, not an assumption: currency pickers and the like. */
const CLIENT_OK = [
  /value:\s*980,\s*label:/,          // a picker option that names UAH
  /currency:\s*980,?\s*(credit|\})/, // AddAccountModal presets: a manual UAH account
  /\?\?\s*980/,                      // a row's own currency, defaulted like the DB column does
  /rates\[String\(code\)\]/,         // the client-side converter itself
];

/**
 * Exemptions, each with the DATE it was granted and the fact it rests on.
 *
 * ⚠️ **An exemption cites a fact, and a fact can expire.** On 2026-08-21 this file was excusing the
 * whole Telegram surface from the hryvnia ban on the grounds that it was owner-only — a statement
 * that had stopped being true three weeks earlier, when §D1 made pushes personal. Nothing in the
 * lint could notice, because the reason lived in a comment nobody re-reads on a green run.
 *
 * So the roster is DATA now, and every green run prints it with its age. That does not verify the
 * facts — nothing here can — but it puts them in front of whoever is running the check, which is
 * the only thing that would have caught the last two.
 */
const RAW_RATES_OK = {
  "lib/finance/money.ts": { since: "2026-08-18", why: "the re-expression itself (§BASE-CUR)" },
};

/**
 * Files allowed to write a hryvnia symbol.
 *
 * ⚠️ **The Telegram exemption is GONE (2026-08-21).** It read "every one of them is Telegram,
 * which is owner-only" — and that stopped being true on 2026-08-01, when §D1 gave every user their
 * own linked chat and moved the pushes off the owner-only gate. The exemption outlived its premise
 * by three weeks, during which a reader in dollars got hryvnia signs over converted figures. This
 * is the second time an exemption survived the reason for it (the first: `budgets.rollover`), so
 * the rule is worth stating: **an exemption cites a fact, and a fact can expire.**
 */
const HRYVNIA_OK = {
  "lib/platform/i18n.ts": { since: "2026-08-18", why: "errCurrencyUnsupported NAMES the units: «₴ UAH, $ USD, € EUR»" },
  "do/migrations.generated.ts": { since: "2026-08-07", why: "embedded SQL text, generated — not source" },
};

function tsFiles(dir, prefix = "", root = ROOT) {
  const out = [];
  for (const e of readdirSync(join(root, dir || "."), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...tsFiles(join(dir, e.name), rel, root));
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith(".test.ts")) out.push(rel);
  }
  return out;
}

/** Strip line and block comments — a symbol inside prose explaining the rule is not a violation. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\/\/[^\n"'`]*$/gm, "");
}

const problems = [];
for (const file of tsFiles("")) {
  if (file.startsWith("test/")) continue;
  const src = readFileSync(join(ROOT, file), "utf8");
  const code = stripComments(src);

  if (/\bgetStoredRates\s*\(/.test(code) && !Object.hasOwn(RAW_RATES_OK, file)) {
    problems.push(
      `${ROOT}/${file}: calls getStoredRates().\n` +
      `    That is the RAW hryvnia table. Use getRates(env) — it answers in the reader's base.`,
    );
  }
  if (code.includes("₴") && !Object.hasOwn(HRYVNIA_OK, file)) {
    problems.push(
      `${ROOT}/${file}: writes a ₴ literal.\n` +
      `    Take the symbol from shared/currency.ts (currencySign) — the reader may not be in hryvnia.`,
    );
  }
}

for (const root of CLIENT_ROOTS) {
  for (const file of tsFiles("", "", root)) {
    const code = stripComments(readFileSync(join(root, file), "utf8"));
    code.split("\n").forEach((line, i) => {
      if (CLIENT_OK.some((ok) => ok.test(line))) return;
      for (const rule of CLIENT_RULES) {
        if (rule.re.test(line)) {
          problems.push(`${root}/${file}:${i + 1}: ${rule.say}\n    ${line.trim().slice(0, 120)}`);
        }
      }
    });
  }
}

if (problems.length) {
  console.error("✗ C10 display currency:\n\n" + problems.map((p) => "  " + p).join("\n\n") + "\n");
  process.exit(1);
}
console.log("✓ C10 display currency: one conversion target on both sides, no hardcoded ₴/980");

/**
 * Print the standing exemptions with their age.
 *
 * The point is not the number of days — it is that the FACTS are on screen on a green run. Both
 * exemptions this lint has ever got wrong were wrong in the same way: the reason was still there,
 * still readable, and no longer true. Nobody re-reads a passing check's source.
 */
const today = new Date();
const ageDays = (since) => Math.round((today - new Date(since)) / 86400000);
const roster = [
  ...Object.entries(RAW_RATES_OK).map(([f, e]) => ["raw rates", f, e]),
  ...Object.entries(HRYVNIA_OK).map(([f, e]) => ["₴ literal", f, e]),
];
if (roster.length) {
  console.log("  standing exemptions — re-read the REASON, not the age:");
  for (const [kind, file, e] of roster) {
    console.log(`    · ${kind}: ${file} — ${e.why} (granted ${e.since}, ${ageDays(e.since)}d ago)`);
  }
}
