#!/usr/bin/env node
/**
 * C2 + C4 — the client and the worker describe API responses with the SAME declaration.
 *
 * WHY THIS EXISTS (defect D2 in ARCHITECTURE.md)
 *
 * `shared/types.ts` was imported by ZERO worker files: the "shared" types were shared in name
 * only. The client hand-declared 86 interfaces describing what it BELIEVED the server returned,
 * the worker declared its own shapes inline (26 of them as `Record<string, unknown>`, which
 * promises nothing at all), and `tsc` saw two independent truths it could not compare. Drift
 * surfaced in production, one field at a time.
 *
 * Moving the declarations into `shared/api/` fixes it once. These two checks are what keep it
 * fixed, because the cheapest next edit will always be to declare a shape where you are standing.
 *
 * C4 — the client declares no response type of its own.
 *   `src/store/api.ts` may IMPORT and RE-EXPORT from `shared/api/`, but not `export interface`.
 *   Re-export is deliberate: 66 files already import these names from `store/api.ts`, and
 *   repointing all of them would be a large diff that proves nothing.
 *
 * C2 — the worker does not describe a row as an anonymous grab-bag.
 *   `Record<string, unknown>` as a return type is how a query says "I promise nothing"; an index
 *   signature (`[key: string]: unknown`) is the same escape hatch worn as a real interface. Both
 *   let a response quietly lose a column. `repo/` is at zero of both and stays there.
 *
 * What is deliberately NOT checked: that every handler carries `satisfies`. A grep for that is
 * trivially defeated by `satisfies any`, and the real guarantee is already structural — the repo
 * layer returns contract types, so a handler that assembles a response out of them is checked by
 * `tsc` whether or not it says so out loud.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const CLIENT_API = "src/store/api.ts";
const WORKER_TYPED_DIRS = ["worker/repo", "worker/services"];

const problems = [];

// ---- C4: the client re-exports the contract, it does not restate it -------------------------

const client = readFileSync(CLIENT_API, "utf8").split("\n");
const declared = [];
client.forEach((line, i) => {
  // `export interface X` / `export type X =` at top level. A LOCAL (non-exported) helper type is
  // fine — it cannot be a response shape if nothing outside the file can name it.
  const m = line.match(/^export (?:interface|type) (\w+)\b/);
  // `export type * from` and `export type { … } from` are re-exports, which is the intended form.
  if (m && !/^export type \* from/.test(line) && !/^export type \{/.test(line)) declared.push([i + 1, m[1]]);
});
for (const [line, name] of declared) {
  problems.push(
    `${CLIENT_API}:${line}: declares \`${name}\` locally.\n` +
    `    An API response type belongs in shared/api/ so the worker can annotate its return with\n` +
    `    the same declaration. Move it there and re-export.`,
  );
}

// ---- C2: no shapeless rows in the layers that talk to the database ---------------------------

function tsFiles(dir, prefix = dir + "/") {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...tsFiles(join(dir, e.name), prefix + e.name + "/"));
    else if (e.name.endsWith(".ts")) out.push(prefix + e.name);
  }
  return out;
}

for (const file of WORKER_TYPED_DIRS.flatMap((d) => tsFiles(d))) {
  const src = readFileSync(file, "utf8").split("\n");
  src.forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // prose about the rule is not a violation
    if (/Record<string,\s*unknown>/.test(line)) {
      problems.push(
        `${file}:${i + 1}: \`Record<string, unknown>\` — a row type that promises nothing.\n` +
        `    Name the columns the query selects, or import the shape from shared/api/.`,
      );
    }
    if (/^\s*\[key: string\]:\s*unknown/.test(line)) {
      problems.push(
        `${file}:${i + 1}: an index signature turns a row type into the same escape hatch.\n` +
        `    List the columns instead — a half-typed row is what let the client and the server\n` +
        `    disagree about which fields exist.`,
      );
    }
  });
}

if (problems.length) {
  console.error("✗ C2/C4 API contract:\n\n" + problems.map((p) => "  " + p).join("\n\n") + "\n");
  process.exit(1);
}

console.log("✓ C2/C4 API contract: response shapes declared once, in shared/api/");
