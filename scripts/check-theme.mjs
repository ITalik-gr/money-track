#!/usr/bin/env node
/**
 * C23 — §THEME: every colour comes from a theme file, and every theme file is complete.
 *
 * THE DEFECT (owner, 2026-09-25: the dark theme is «дуже погана»). The dark theme was a block of
 * overrides at the bottom of `tokens.css` plus ~60 colours hard-coded across the stylesheets and
 * ~80 more in components, none of which followed it: tooltips pinned to the dark `--bg`, white text
 * on a light accent, light category colours on a near-black card, three `data-theme` twins that
 * disagreed with each other and two `prefers-color-scheme` blocks that could never match. Each was
 * a rule someone had to REMEMBER. This makes the whole class a failed check instead.
 *
 * WHAT IS REFUSED
 *   1. Theme files out of step: every `src/styles/theme-<name>.css` defines EXACTLY the same set of
 *      custom properties and sets `color-scheme`; the set of theme files equals `THEMES` in
 *      `src/lib/theme.ts` and the keys of `BG` in `public/theme.js`, and each `BG` value equals
 *      that theme's `--bg` (the browser chrome before first paint).
 *   2. A theme token defined anywhere else (it would win or lose by cascade accident).
 *   3. A rule scoped to a theme outside the theme files — `[data-theme…]` or
 *      `prefers-color-scheme` in CSS, `data-theme` in a component. A colour role that differs by
 *      theme is a TOKEN, not a twin rule.
 *   4. A colour literal (hex, rgb(), hsl(), `white`/`black`) in a stylesheet other than the theme
 *      files and `tokens.css` (the theme-independent palette). `landing.css` is the one exception.
 *   5. A colour literal in `src/` TS/TSX outside the KEEP list.
 *   6. An inline paint (`style={…}` background/color/border/`--*-color`, SVG `fill`/`stroke`/
 *      `stopColor`) whose value is an expression that does not go through `catColor()` — a stored
 *      category colour painted raw is the light palette on a dark card (§CAT-COLOR). Literal
 *      `var(--…)` strings are fine. `catColor` is idempotent, so wrapping at the paint is always safe.
 * KEEP lists only shrink.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const STYLES = "src/styles";
const problems = [];
const stripCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");

// ---- 1. theme files ---------------------------------------------------------------------------
const themeFiles = readdirSync(STYLES).filter((f) => /^theme-[\w-]+\.css$/.test(f)).sort();
const themes = {};
for (const f of themeFiles) {
  const name = f.slice("theme-".length, -".css".length);
  const css = stripCss(readFileSync(join(STYLES, f), "utf8"));
  const props = new Map();
  for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) props.set(m[1], m[2].trim());
  if (!/color-scheme\s*:/.test(css)) problems.push(`${f}: no \`color-scheme\` — native controls and scrollbars would stay in the other theme`);
  themes[name] = props;
}
const names = Object.keys(themes);
if (names.length < 2) problems.push(`expected at least two theme files in ${STYLES}, found: ${themeFiles.join(", ") || "none"}`);
const allTokens = new Set(names.flatMap((n) => [...themes[n].keys()]));
for (const n of names) {
  for (const tok of allTokens) {
    if (!themes[n].has(tok)) problems.push(`theme-${n}.css: missing ${tok} (another theme defines it — this one would silently inherit the wrong value)`);
  }
}

const themeTs = readFileSync("src/lib/theme.ts", "utf8");
const tsThemes = (/export const THEMES = \[([^\]]*)\]/.exec(themeTs)?.[1] ?? "").match(/"[\w-]+"/g)?.map((s) => s.slice(1, -1)) ?? [];
if (tsThemes.sort().join() !== [...names].sort().join()) {
  problems.push(`src/lib/theme.ts: THEMES = [${tsThemes.join(", ")}] but the theme files are [${names.join(", ")}]`);
}
const bootJs = readFileSync("public/theme.js", "utf8");
const bg = {};
for (const m of (/var BG = \{([^}]*)\}/.exec(bootJs)?.[1] ?? "").matchAll(/(\w+)\s*:\s*"([^"]+)"/g)) bg[m[1]] = m[2];
if (Object.keys(bg).sort().join() !== [...names].sort().join()) {
  problems.push(`public/theme.js: BG has [${Object.keys(bg).join(", ")}] but the theme files are [${names.join(", ")}]`);
}
for (const n of names) {
  const want = themes[n].get("--bg");
  if (bg[n] && want && bg[n].toLowerCase() !== want.toLowerCase()) {
    problems.push(`public/theme.js: BG.${n} = ${bg[n]} but theme-${n}.css has --bg: ${want} (the chrome would flash a different colour before the page)`);
  }
}
const html = readFileSync("index.html", "utf8");
const metaColor = /<meta name="theme-color" content="([^"]+)"/.exec(html)?.[1];
if (metaColor && themes.light && metaColor.toLowerCase() !== themes.light.get("--bg")?.toLowerCase()) {
  problems.push(`index.html: <meta name="theme-color"> is ${metaColor}, the light --bg is ${themes.light.get("--bg")}`);
}

// ---- 2–4. the other stylesheets ------------------------------------------------------------------
/** Stylesheets allowed to hold colour literals, with the reason. */
const LITERAL_OK = {
  "tokens.css": "the theme-independent palette: stored category hexes and physical card faces",
  "landing.css": "marketing page: its lightbox is white-on-scrim in both themes and its hero shadows are art-directed (DESIGN §8)",
};
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(|(?<![\w.-])(?:white|black)(?![\w-])/;
for (const f of readdirSync(STYLES).filter((n) => n.endsWith(".css") && !themeFiles.includes(n))) {
  const lines = stripCss(readFileSync(join(STYLES, f), "utf8")).split("\n");
  lines.forEach((line, i) => {
    const at = `${STYLES}/${f}:${i + 1}`;
    if (/\[data-theme|prefers-color-scheme/.test(line)) problems.push(`${at}: a rule scoped to a theme — make the colour a token in the theme files instead`);
    const def = /^\s*(--[\w-]+)\s*:/.exec(line);
    if (def && allTokens.has(def[1])) problems.push(`${at}: redefines theme token ${def[1]} — theme tokens live only in theme-*.css`);
    if (!LITERAL_OK[f]) {
      const code = line.replace(/url\([^)]*\)/g, "").replace(/white-space/g, "");
      if (COLOR_LITERAL.test(code)) problems.push(`${at}: colour literal \`${line.trim().slice(0, 90)}\` — use a token (or add one to both theme files)`);
    }
  });
}

// ---- 5–6. components ------------------------------------------------------------------------------
/** Files allowed to hold colour literals — each is DATA, not paint. */
const TS_LITERAL_OK = {
  "src/lib/brands.tsx": "merchant brand colours — a brand's own colour, the same in both themes",
  "src/components/planning/CategoryModal.tsx": "the picker's palette: these hexes are STORED on the category (painted via catColor)",
  "src/components/planning/GoalModal.tsx": "the picker's palette: stored on the goal (painted via catColor)",
  "src/components/planning/GroupModal.tsx": "the picker's palette and kind defaults: stored on the group (painted via catColor)",
  "src/lib/theme.ts": "documents the mixing formula",
};
/** Inline paints that legitimately bypass catColor: `file: [substring of the value]`. */
const PAINT_OK = {
  "src/components/ui/MerchantLogo.tsx": ["brand.color", "fg"], // a brand's own colours
};
const PAINT_PROP = /(?:^|[\s,{])(background|backgroundColor|borderColor|color|outlineColor|"--[\w-]*color")\s*:\s*/g;
const SVG_PAINT = /\b(fill|stroke|stopColor)=\{/g;

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}
/** The text of a balanced `{…}` starting at `start` (which must be `{`). */
function braced(src, start) {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start + 1, i);
  }
  return src.slice(start + 1);
}
/** A property value inside an object literal: up to the next top-level `,` or the end. */
function valueAt(src, start) {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) { if (depth === 0) return src.slice(start, i); depth--; }
    else if (c === "," && depth === 0) return src.slice(start, i);
  }
  return src.slice(start);
}
const lineOf = (src, idx) => src.slice(0, idx).split("\n").length;
function checkValue(file, src, idx, prop, v) {
  const val = v.trim();
  if (!val || val === "undefined") return;
  const at = `${file}:${lineOf(src, idx)}`;
  // A template that splices a value into a colour (`color-mix(in srgb, ${c} 14%, …)`) is a paint too.
  if (/^`[\s\S]*`$/.test(val) && val.includes("${")) {
    for (const m of val.matchAll(/\$\{([^}]*)\}/g)) {
      if (/color|Color/.test(m[1]) && !m[1].includes("catColor(") && !(PAINT_OK[file] ?? []).some((k) => m[1].includes(k))) {
        problems.push(`${at}: ${prop} splices \`${m[1].trim()}\` into a colour raw — wrap it in catColor() (§CAT-COLOR)`);
      }
    }
    return;
  }
  if (/^(["'`])[^"'`]*\1$/.test(val)) {
    if (/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(val) && !TS_LITERAL_OK[file]) problems.push(`${at}: ${prop} is a colour literal ${val} — use a var(--token)`);
    return;
  }
  if (val.includes("catColor(")) return;
  if ((PAINT_OK[file] ?? []).some((k) => val.includes(k))) return;
  // Pure token expressions (`cond ? "var(--neg)" : "var(--pos)"`) need no lifting.
  if (!/[A-Za-z_$][\w$]*(?:\.[\w$]+|\[[^\]]+\])*\s*(?:\?\?|[,)?:]|$)/.test(val.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, ""))) return;
  if (!/color|Color|tone|paint|fill|stroke|dot|bar/i.test(val)) return;
  problems.push(`${at}: ${prop} paints \`${val.slice(0, 70)}\` raw — wrap it in catColor() (§CAT-COLOR)`);
}
for (const file of walk("src")) {
  if (file.startsWith("src/i18n/")) continue;
  const src = readFileSync(file, "utf8");
  const code = src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  if (file !== "src/lib/theme.ts" && /data-theme/.test(code)) problems.push(`${file}: touches data-theme — only src/lib/theme.ts switches the theme (useTheme / setTheme)`);
  if (!TS_LITERAL_OK[file]) {
    for (const m of code.matchAll(/["'`]#[0-9a-fA-F]{3,8}["'`]|\brgba?\(/g)) {
      problems.push(`${file}:${lineOf(code, m.index)}: colour literal ${m[0]} — use a var(--token) (theme files) or CAT_FALLBACK`);
    }
  }
  if (!file.endsWith(".tsx")) continue;
  for (const m of code.matchAll(/\bstyle=\{/g)) {
    const body = braced(code, m.index + m[0].length - 1);
    for (const p of body.matchAll(PAINT_PROP)) {
      const start = p.index + p[0].length;
      checkValue(file, code, m.index, p[1], valueAt(body, start));
    }
  }
  for (const m of code.matchAll(SVG_PAINT)) {
    checkValue(file, code, m.index, m[1], braced(code, m.index + m[0].length - 1));
  }
}

if (problems.length) {
  console.error(`C23 theme check — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error("  " + p);
  console.error("\n  §THEME: colours live in src/styles/theme-*.css (same token set in each); stored colours paint via catColor().");
  process.exit(1);
}
console.log(`C23 theme: ${names.length} themes × ${allTokens.size} tokens in step; no stray colours, no theme-scoped rules, stored colours lifted.`);
