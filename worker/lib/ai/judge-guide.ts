// What each seed category MEANS, for Jev — read out of the SAME guide the Haiku prompt carries.
//
// Phase 1 had its own condensed table here, and the held-out run showed what a second definition
// costs: the condensed copy had dropped «Нова лінія», «Prostor», «Antoshka» and the rest of the
// brand lists, so Jev filed those shops under Other while Haiku, reading the full guide, did not
// (docs/JEV.md §7.2). One guide, parsed, means a brand added for one judge reaches both.
//
// The parse is deliberately loose — `CACHE_GUIDE` is prose written for a model, not a data file —
// and `judge-tx.test.ts` pins that every seed root and leaf still comes out of it with a text.
// A category the guide does not describe (a user's own) is offered by name alone.
import { CACHE_GUIDE } from "./prompt.ts";

export interface CategoryGuide {
  /** The guide's own sentence(s) for this category. */
  covers: string;
  /** Raw bank descriptions the guide files here, verbatim. */
  examples: string[];
}

function parse(): Map<number, CategoryGuide> {
  const out = new Map<number, CategoryGuide>();
  const get = (id: number) => {
    let g = out.get(id);
    if (!g) out.set(id, (g = { covers: "", examples: [] }));
    return g;
  };
  for (const line of CACHE_GUIDE.split("\n")) {
    // «- Groceries (1): …» / «- Streaming (42, under Entertainment): …» — a category's own line.
    const cat = /^- ([^("]+?) \((\d+)(?:, under [^)]+)?\): (.+)$/.exec(line);
    if (cat) {
      const [, name, id, text] = cat;
      const subs = text.split(/\s*Subcategories:\s*/)[1];
      get(Number(id)).covers = `${name}: ${text}`;
      // «Supermarket (30) — АТБ, Сільпо…; Market (31) — …» — the leaves described inside it. A
      // leaf's text stops at the first full stop: what follows is the parent's again.
      if (subs) {
        for (const seg of subs.split(/;\s*/)) {
          const leaf = /^(.+?) \((\d+)\)(?: — (.+))?$/.exec(seg.trim());
          if (!leaf) continue;
          const desc = (leaf[3] ?? "").split(/\.\s/)[0].replace(/\.$/, "");
          const g = get(Number(leaf[2]));
          if (!g.covers) g.covers = desc ? `${leaf[1]}: ${desc}` : leaf[1];
        }
      }
      continue;
    }
    // «- "ATB 320.50" -> the АТБ supermarket -> Supermarket (30)», sometimes «"A" / "B" -> …».
    const ex = /^- ((?:"[^"]+"(?: \/ )?)+) -> .+ \((\d+)\)$/.exec(line);
    if (ex) {
      const g = get(Number(ex[2]));
      for (const m of ex[1].matchAll(/"([^"]+)"/g)) g.examples.push(m[1]);
    }
  }
  return out;
}

let cached: Map<number, CategoryGuide> | null = null;

/** The guide for one category id, or null when the guide does not describe it. */
export function categoryGuide(id: number): CategoryGuide | null {
  cached ??= parse();
  const g = cached.get(id);
  return g && g.covers ? g : null;
}
