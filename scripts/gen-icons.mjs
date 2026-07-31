// Renders the PWA icon set from one SVG master.
//
// Why PNGs at all, when `public/favicon.svg` already exists: iOS ignores SVG in a web-app
// manifest and ignores `apple-touch-icon` unless it is a PNG, so a "Add to Home Screen" install
// showed a blank/screenshot tile. Android needs a `maskable` variant with the glyph inside the
// 80% safe circle, or the launcher crops the mark.
//
// Run: `node scripts/gen-icons.mjs`. Output is committed — this is not part of the build, so a
// contributor without sharp can still build the app.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(root, "public/icons");
mkdirSync(OUT, { recursive: true });

const INK = "#0f1620";
const ACCENT = "#2e6be6";
const MONO = "Menlo, Consolas, 'DejaVu Sans Mono', monospace";

/**
 * @param {number} size    canvas size
 * @param {number} inset   fraction of the canvas kept free around the mark (maskable safe zone)
 * @param {number} radius  corner radius as a fraction of the mark's side (0.5 = circle)
 */
function svg(size, inset, radius, bleed) {
  const m = size * inset;            // margin
  const s = size - m * 2;            // mark side
  const r = s * radius;
  const cx = m + s / 2;
  // The dot sits in the lower-right corner of the MARK, with enough clearance that it never
  // touches the glyph — on the first render it collided with the ₴ and read as a printing defect.
  const dot = s * 0.072;
  const dotC = m + s * 0.795;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  ${bleed ? `<rect width="${size}" height="${size}" fill="${INK}"/>` : ""}
  <rect x="${m}" y="${m}" width="${s}" height="${s}" rx="${r}" fill="${INK}"/>
  <text x="${cx}" y="${m + s * 0.5}" fill="#ffffff" font-family="${MONO}"
        font-size="${s * 0.46}" font-weight="700" text-anchor="middle" dominant-baseline="central">₴</text>
  <circle cx="${dotC}" cy="${dotC}" r="${dot}" fill="${ACCENT}"/>
</svg>`;
}

const targets = [
  // [file, size, inset, radius, bleed]
  // Plain icons: rounded square on TRANSPARENT corners — the browser and most launchers show
  // them as-is, and a square ink block looks wrong on a light page.
  ["icon-192.png", 192, 0.02, 0.235, false],
  ["icon-512.png", 512, 0.02, 0.235, false],
  // Maskable: ink to the edges, mark pulled into the 80% safe circle — the launcher may crop.
  ["icon-maskable-512.png", 512, 0.16, 0.3, true],
  // iOS composites its own rounded corners and never honours transparency, so this one is square.
  ["apple-touch-icon.png", 180, 0, 0, true],
];

for (const [file, size, inset, radius, bleed] of targets) {
  const png = await sharp(Buffer.from(svg(size, inset, radius, bleed))).png().toBuffer();
  writeFileSync(resolve(OUT, file), png);
  console.log(`✓ ${file} (${size}×${size}, ${(png.length / 1024).toFixed(1)} KB)`);
}
