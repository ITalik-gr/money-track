#!/usr/bin/env node
/**
 * C3 — no route or service file grows back into a landfill.
 *
 * WHY THIS EXISTS
 *
 * `api.ts` reached 3 331 lines, 179 inline queries and 26 domains not because anyone decided to
 * write a huge file, but because appending to the end of an existing file is always the smallest
 * possible diff. Splitting it once fixes nothing on its own; nothing stopped the same drift from
 * starting again the next morning. The rule that keeps it split has to be mechanical.
 *
 * THE RULE
 *
 * Every `.ts` file under `worker/routes/`, `worker/services/` and `worker/lib/` stays under CAP
 * lines. Files already above it are listed in EXCEPTIONS, and an exception may never RISE.
 *
 * `lib/` was added on 2026-08-07, after phase 5. It was left out at first on the theory that
 * domain logic legitimately runs longer than transport — but that is exactly the theory under
 * which `ai.ts` reached 1 335 lines carrying six unrelated jobs. The cap is the same everywhere;
 * what differs is how many exceptions a directory needs, and each one is a debt with a name.
 *
 * WHY NOT A STRICT TWO-DIRECTIONAL RATCHET LIKE C1
 *
 * `check-repo-layer.mjs` also fails when a count drops below its budget, and that is right there:
 * a query count moves in whole steps and rarely, so a drop means someone forgot to tighten it.
 * Line counts move on every edit, and a check that fails because a file got three lines shorter
 * trains people to edit the budget without reading it — which is exactly how a guard becomes
 * decoration. So this one only fails when the slack is large enough to be real drift (SLACK).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIRS = ["worker/routes", "worker/services", "worker/lib"];
const CAP = 400;
const SLACK = 80; // tighten an exception once it is this far under its allowance

/**
 * Files allowed above CAP. ONLY EVER GOES DOWN — delete the line once a file is under the cap.
 */
const EXCEPTIONS = {
  // 19 dense reporting handlers over one prefix. Splitting it further means splitting `/analytics`
  // itself into sub-domains, which is a design decision and not a mechanical move.
  // 2026-08-14 (§INCOME-PLAN): 720 → 687. Adding expected income pushed this file over, and the
  // answer was an extraction, not a bigger number — `cashflowMoves` + `safeToSpend` moved to
  // `lib/finance/cashflow.ts`, which is where "which money moves when" belonged anyway. The
  // exception ratchets down with the file so the slack cannot be spent twice.
  // 2026-08-14 (§CAT-PAGE): 687 → 655 — the category drill followed, into `category-drill.ts`.
  "worker/routes/api/analytics.ts": 670,
  // Predates the split: the Telegram bot's command surface, still holding 3 inline queries too.
  "worker/routes/telegram.ts": 320,
  // The AI adviser: the finance snapshot, the chat, the chat's tools, and the deterministic
  // fallback advice. The snapshot alone is the single source every AI screen reads, so splitting
  // it is a design decision — recorded rather than done.
  // 1120 → 1080 (2026-08-07): streaming pushed the file over its allowance, and instead of
  // raising the number the §A1 facts CRUD moved to `lib/ai/facts.ts` — where it belonged anyway,
  // since it is plain CRUD with no advice logic in it. Second time C3 has forced that call.
  // 2026-08-08: 1080 → 909 after the chat's TOOLS moved to `lib/ai/chat-tools.ts`. The ratchet
  // did its job — English prompts are longer than the Ukrainian they replaced, the file hit the
  // ceiling, and the answer was a seam rather than a bigger number.
  "worker/lib/ai/advisor.ts": 909,
  // The notification centre: one drafting function per event kind, plus the Telegram push.
  "worker/lib/messaging/notify.ts": 1000,
  // The canon itself. Long ON PURPOSE — this is the file the whole project points at when it says
  // "one number, one home", and cutting it up would give that number two homes again.
  "worker/lib/finance/stats.ts": 500,
  // Categorisation, transfer review and text parsing — three model calls that share a taxonomy.
  "worker/lib/ai/enrich.ts": 530,
};

function tsFiles(dir, prefix = dir + "/") {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...tsFiles(join(dir, e.name), prefix + e.name + "/"));
    else if (e.name.endsWith(".ts")) out.push(prefix + e.name);
  }
  return out;
}

const problems = [];
let worst = 0;

for (const file of DIRS.flatMap((d) => tsFiles(d))) {
  const lines = readFileSync(file, "utf8").split("\n").length;
  const allowed = EXCEPTIONS[file] ?? CAP;
  if (!EXCEPTIONS[file]) worst = Math.max(worst, lines);

  if (lines > allowed) {
    problems.push(
      EXCEPTIONS[file]
        ? `${file}: ${lines} lines, exception allows ${allowed}.\n` +
          `    An exception may never rise. Move handlers out instead.`
        : `${file}: ${lines} lines, the cap is ${CAP}.\n` +
          `    Split it by path prefix, the way routes/api/ is organised — do not raise the cap.`,
    );
  } else if (EXCEPTIONS[file] && lines < allowed - SLACK) {
    problems.push(
      `${file}: down to ${lines} lines (exception still says ${allowed}).\n` +
      `    Lower it in scripts/check-route-size.mjs, or delete the line if it is under ${CAP}.`,
    );
  }
}

if (problems.length) {
  console.error("✗ C3 file size:\n\n" + problems.map((p) => "  " + p).join("\n\n") + "\n");
  process.exit(1);
}

console.log(
  `✓ C3 file size: largest un-excepted route/service file is ${worst} lines (cap ${CAP}, ` +
  `${Object.keys(EXCEPTIONS).length} exceptions)`,
);
