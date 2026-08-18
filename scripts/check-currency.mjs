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
 *     `notif-i18n` in the feed. The Telegram surface is exempt: it is owner-only by the security
 *     audit, and the owner reads hryvnia.
 *
 * WHY A CHECK. The whole feature works by making the OLD call sites right without touching them
 * (`getRates` kept its name and its return type). That is what made it possible at all, and it is
 * exactly what makes a regression invisible: the wrong version compiles, runs, and renders a
 * plausible number. `tsc` cannot tell two `Record<string, number>` maps apart.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = "worker";

/** Files allowed to read the raw stored rate table. */
const RAW_RATES_OK = new Set([
  "lib/finance/money.ts",          // the re-expression itself
]);

/**
 * Files allowed to write a hryvnia symbol. Every one of them is Telegram, which is owner-only
 * (CLAUDE.md §Безпека) — plus the one string that NAMES the available currencies to the user.
 */
const HRYVNIA_OK = new Set([
  "lib/messaging/alert.ts",
  "lib/messaging/proactive.ts",
  "routes/telegram.ts",
  "lib/platform/i18n.ts",          // errCurrencyUnsupported lists «₴ UAH, $ USD, € EUR»
  "do/migrations.generated.ts",    // embedded SQL text, generated
]);

function tsFiles(dir, prefix = "") {
  const out = [];
  for (const e of readdirSync(join(ROOT, dir || "."), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...tsFiles(join(dir, e.name), rel));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(rel);
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

  if (/\bgetStoredRates\s*\(/.test(code) && !RAW_RATES_OK.has(file)) {
    problems.push(
      `${ROOT}/${file}: calls getStoredRates().\n` +
      `    That is the RAW hryvnia table. Use getRates(env) — it answers in the reader's base.`,
    );
  }
  if (code.includes("₴") && !HRYVNIA_OK.has(file)) {
    problems.push(
      `${ROOT}/${file}: writes a ₴ literal.\n` +
      `    Take the symbol from shared/currency.ts (currencySign) — the reader may not be in hryvnia.`,
    );
  }
}

if (problems.length) {
  console.error("✗ C10 display currency:\n\n" + problems.map((p) => "  " + p).join("\n\n") + "\n");
  process.exit(1);
}
console.log("✓ C10 display currency: one conversion target, no hardcoded ₴ outside Telegram");
