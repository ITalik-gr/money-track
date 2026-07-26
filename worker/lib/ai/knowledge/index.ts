import type { KnowledgeDoc, KnowledgeRow, KnowledgeMetaItem } from "./types.ts";
import { DOC_MAX_CHARS, USER_TOTAL_MAX_CHARS } from "./types.ts";
import { personalFinance } from "./personal-finance.ts";
import { appMethodology } from "./app-methodology.ts";
import { investing } from "./investing.ts";

export type { KnowledgeDoc, KnowledgeRow, KnowledgeMetaItem } from "./types.ts";
export { DOC_MAX_CHARS, USER_TOTAL_MAX_CHARS } from "./types.ts";
import type { AppDb } from "../db-shim.ts";

// Вбудований корпус знань (§A5) — стабільний довідник для AI. Порядок фіксований: він впливає
// на байт-ідентичність кешованого блока (cache_control), тож НЕ сортувати динамічно.
export const KNOWLEDGE_DOCS: KnowledgeDoc[] = [personalFinance, appMethodology, investing];

const PREAMBLE =
  "БАЗА ЗНАНЬ (довідкові принципи, якими ти керуєшся як фінменеджер). " +
  "Це ЗАГАЛЬНІ знання, а НЕ дані цього користувача — конкретні числа завжди бери з фінансового контексту нижче, " +
  "а не звідси. Якщо принцип суперечить реальній ситуації користувача — пріоритет у реальних даних.";

const USER_NOTE =
  "Далі — нотатки, які написав САМ користувач (його правила, контекст, домовленості). " +
  "Став їх вище за загальні принципи, коли вони суперечать, але НІКОЛИ вище за реальні числа з фінансового контексту.";

function render(docs: { title: string; body: string }[]): string {
  return docs.map((d) => `# ${d.title}\n${d.body}`).join("\n\n---\n\n");
}

// Вбудований корпус без користувацького шару. Лишається як фолбек: якщо таблиці 0028 ще нема
// на remote, чат має працювати по-старому, а не падати.
export const KNOWLEDGE_CORPUS: string = [PREAMBLE, render(KNOWLEDGE_DOCS)].join("\n\n---\n\n");

async function loadRows(db: AppDb): Promise<KnowledgeRow[]> {
  try {
    const r = await db
      .prepare("SELECT id, kind, title, summary, body, enabled, created_at, updated_at FROM knowledge_docs ORDER BY created_at, id")
      .all<KnowledgeRow>();
    return r.results ?? [];
  } catch {
    return []; // таблиці ще нема (0028 не накочено) — деградуємо до вбудованого корпусу
  }
}

const isLocked = (id: string) => KNOWLEDGE_DOCS.some((d) => d.id === id && d.locked);

/**
 * Ефективний корпус = вбудовані доки (з урахуванням override/вимкнення) + власні нотатки.
 *
 * ⚠️ Порядок детермінований (вбудовані у фіксованому порядку, власні — за created_at):
 * блок іде в промт із `cache_control`, і будь-яке «плавання» порядку вбивало б prompt-cache
 * на кожному виклику. Текст міняється лише коли користувач реально відредагував документ —
 * тоді кеш прогрівається наново один раз, це нормально.
 */
export async function buildKnowledgeCorpus(db: AppDb): Promise<string> {
  const rows = await loadRows(db);
  const byId = new Map(rows.map((r) => [r.id, r]));

  const builtin = KNOWLEDGE_DOCS.flatMap((d) => {
    const o = byId.get(d.id);
    if (!o || o.kind !== "override" || isLocked(d.id)) return [{ title: d.title, body: d.body }];
    if (!o.enabled) return [];
    return [{ title: o.title || d.title, body: o.body }];
  });

  const user = rows
    .filter((r) => r.kind === "user" && r.enabled)
    .map((r) => ({ title: r.title, body: r.body }));

  const parts = [PREAMBLE, render(builtin)];
  if (user.length) parts.push(USER_NOTE + "\n\n" + render(user));
  return parts.join("\n\n---\n\n");
}

// Метадані для UI (картка «Корпус знань») — без важкого body.
export async function knowledgeMeta(db: AppDb): Promise<{ docs: KnowledgeMetaItem[]; user_chars: number; user_limit: number; doc_limit: number }> {
  const rows = await loadRows(db);
  const byId = new Map(rows.map((r) => [r.id, r]));

  const docs: KnowledgeMetaItem[] = KNOWLEDGE_DOCS.map((d) => {
    const o = byId.get(d.id);
    const locked = !!d.locked;
    const active = o && o.kind === "override" && !locked;
    return {
      id: d.id,
      title: active ? o!.title || d.title : d.title,
      summary: active ? o!.summary || d.summary : d.summary,
      chars: active ? o!.body.length : d.body.length,
      kind: "builtin" as const,
      locked,
      enabled: active ? !!o!.enabled : true,
      // «Змінено» — лише коли текст справді інший: вимкнення теж пишеться рядком override,
      // і без цієї перевірки вимкнений заводський док читався б як переписаний.
      overridden: !!active && o!.body !== d.body,
      updated_at: active ? o!.updated_at : null,
    };
  });

  let userChars = 0;
  for (const r of rows) {
    if (r.kind !== "user") continue;
    userChars += r.body.length;
    docs.push({
      id: r.id, title: r.title, summary: r.summary, chars: r.body.length,
      kind: "user", locked: false, enabled: !!r.enabled, overridden: false, updated_at: r.updated_at,
    });
  }

  return { docs, user_chars: userChars, user_limit: USER_TOTAL_MAX_CHARS, doc_limit: DOC_MAX_CHARS };
}

// Тіло документа для редактора: override → збережене, інакше — вбудоване.
export async function knowledgeBody(db: AppDb, id: string): Promise<{ id: string; title: string; summary: string; body: string; kind: "builtin" | "user"; locked: boolean; enabled: boolean; overridden: boolean } | null> {
  const rows = await loadRows(db);
  const row = rows.find((r) => r.id === id);
  const base = KNOWLEDGE_DOCS.find((d) => d.id === id);

  if (base) {
    const active = row && row.kind === "override" && !base.locked;
    return {
      id, kind: "builtin", locked: !!base.locked,
      title: active ? row!.title || base.title : base.title,
      summary: active ? row!.summary || base.summary : base.summary,
      body: active ? row!.body : base.body,
      enabled: active ? !!row!.enabled : true,
      overridden: !!active && row!.body !== base.body,
    };
  }
  if (row && row.kind === "user") {
    return { id, kind: "user", locked: false, title: row.title, summary: row.summary, body: row.body, enabled: !!row.enabled, overridden: false };
  }
  return null;
}

// Скільки символів займають ВЛАСНІ доки без урахування `exceptId` — щоб редагування наявного
// доку не рахувало його ж старий розмір проти ліміту.
export async function userCharsExcept(db: AppDb, exceptId?: string): Promise<number> {
  const rows = await loadRows(db);
  return rows.filter((r) => r.kind === "user" && r.id !== exceptId).reduce((s, r) => s + r.body.length, 0);
}

export { isLocked };
