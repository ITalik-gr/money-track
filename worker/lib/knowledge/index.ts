import type { KnowledgeDoc } from "./types.ts";
import { personalFinance } from "./personal-finance.ts";
import { appMethodology } from "./app-methodology.ts";
import { investing } from "./investing.ts";

export type { KnowledgeDoc } from "./types.ts";

// Вбудований корпус знань (§A5) — стабільний довідник для AI. Порядок фіксований: він впливає
// на байт-ідентичність кешованого блока (cache_control), тож НЕ сортувати динамічно.
export const KNOWLEDGE_DOCS: KnowledgeDoc[] = [personalFinance, appMethodology, investing];

// Зібраний текст для промта. Обгортка чітко каже моделі: це загальний довідник, НЕ дані користувача.
export const KNOWLEDGE_CORPUS: string = [
  "БАЗА ЗНАНЬ (довідкові принципи, якими ти керуєшся як фінменеджер). " +
    "Це ЗАГАЛЬНІ знання, а НЕ дані цього користувача — конкретні числа завжди бери з фінансового контексту нижче, " +
    "а не звідси. Якщо принцип суперечить реальній ситуації користувача — пріоритет у реальних даних.",
  ...KNOWLEDGE_DOCS.map((d) => `# ${d.title}\n${d.body}`),
].join("\n\n---\n\n");

// Метадані для UI (картка «Корпус знань» на рейлі Порадника) — без важкого body.
export function knowledgeMeta() {
  return KNOWLEDGE_DOCS.map((d) => ({ id: d.id, title: d.title, summary: d.summary, chars: d.body.length }));
}
