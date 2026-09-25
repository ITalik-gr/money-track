#!/usr/bin/env node
/**
 * C21 — a clickable `<div>`/`<span>`/`<li>` is a control, and a control must be reachable without a
 * mouse: it needs a `role` (and, where it is one, a tab stop and Enter/Space — a real <button> is
 * better whenever the markup allows it).
 *
 * Measured 2026-09-25: seven such elements; five were overlays/scrims (click-outside-to-close, which
 * is not a control — Escape closes those) and two were real controls a keyboard could not reach:
 * the conversation list in Chat and the ✕ on a sub-category chip. Both fixed; this keeps the next
 * one from arriving silently.
 *
 * Allowed without a role: an element whose class names an overlay/scrim/backdrop, and a handler that
 * only stops propagation (the sheet inside an overlay). Everything else fails.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function* tsx(dir) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) yield* tsx(p);
    else if (p.endsWith(".tsx")) yield p;
  }
}

/** The whole opening tag from `<` to its closing `>`, skipping `>` inside `{…}` and quotes (`=>`). */
function openingTag(src, start) {
  let depth = 0, quote = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === "`") { if (depth > 0 || c === '"') quote = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

const START = /<(div|span|li|td|tr|img)\b/g;
const problems = [];
for (const f of tsx("src")) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(START)) {
    const tag = openingTag(src, m.index);
    const click = /\bonClick=\{([\s\S]*?)\}\s*(?:\w+=|\/?>|$)/.exec(tag);
    if (!click) continue;
    if (/\brole=/.test(tag) || /\baria-hidden\b/.test(tag)) continue;
    if (/className=["{`][^"}`]*(overlay|scrim|backdrop)/.test(tag)) continue;
    if (/^\s*\(?e\)?\s*=>\s*e\.stopPropagation\(\)\s*$/.test(click[1])) continue;
    const line = src.slice(0, m.index).split("\n").length;
    problems.push(`${f}:${line} — <${m[1]} onClick> with no role`);
  }
}
if (problems.length) {
  console.error("✗ C21 a11y: a clickable element a keyboard cannot reach:\n\n" + problems.map((p) => "  " + p).join("\n") +
    "\n\n  Use a <button>, or add role + tabIndex + Enter/Space (see the Chat conversation list).\n");
  process.exit(1);
}
console.log("✓ C21 a11y: every clickable non-button has a role (overlays and scrims aside)");
