// Один документ вбудованого корпусу знань (§A5). body — markdown-текст, який іде в промт.
export type KnowledgeDoc = {
  id: string;
  title: string;
  summary: string;
  body: string;
  // locked=true — доку не можна ні переписати, ні вимкнути. Ставиться ЛИШЕ там, де текст
  // описує канон розрахунків самого застосунку: якщо його підмінити, AI почне пояснювати
  // цифри не так, як їх рахує код, і UI розійдеться з AI.
  locked?: boolean;
};

// Рядок таблиці `knowledge_docs` (міграція 0028) — користувацький шар поверх вбудованого.
export type KnowledgeRow = {
  id: string;
  kind: "user" | "override";
  title: string;
  summary: string;
  body: string;
  enabled: number;
  created_at: number;
  updated_at: number;
};

// Те, що бачить UI: вбудовані + користувацькі, уже злиті.
export type KnowledgeMetaItem = {
  id: string;
  title: string;
  summary: string;
  chars: number;
  kind: "builtin" | "user";
  locked: boolean;
  enabled: boolean;
  overridden: boolean;
  updated_at: number | null;
};

// Ліміти на розмір: корпус їде в КОЖЕН виклик чату як кешований блок. Без стелі один
// вставлений «роман» подорожчав би кожну відповідь назавжди.
export const DOC_MAX_CHARS = 20_000;
export const USER_TOTAL_MAX_CHARS = 60_000;
