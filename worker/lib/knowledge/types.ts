// Один документ вбудованого корпусу знань (§A5). body — markdown-текст, який іде в промт.
export type KnowledgeDoc = {
  id: string;
  title: string;
  summary: string;
  body: string;
};
