// `/knowledge/*` — the AI knowledge corpus: user notes plus overrides of the built-in docs.
import * as knowledgeRepo from "../../repo/knowledge.ts";
import { st } from "../../lib/platform/i18n.ts";
import { apiRoutes } from "./_shared.ts";
import type { KnowledgeList, KnowledgeDocFull } from "../../../shared/api/ai.ts";

export const knowledge = apiRoutes();

// §A5: корпус знань — вбудовані доки + користувацький шар (`knowledge_docs`, міграція 0028).
// Тут лише транспорт; злиття/ліміти/локи — у `worker/lib/knowledge/index.ts`.
knowledge.get("/knowledge", async (c) => {
  const { knowledgeMeta } = await import("../../lib/ai/knowledge/index.ts");
  return c.json(await knowledgeMeta(c.env.DB, c.get("locale")) satisfies KnowledgeList);
});

// Повний текст документа — для редактора. Для вбудованого без заміни віддає вбудований текст,
// щоб «редагувати» починалося з реального вмісту, а не з порожнечі.
knowledge.get("/knowledge/:id", async (c) => {
  const { knowledgeBody } = await import("../../lib/ai/knowledge/index.ts");
  const doc = await knowledgeBody(c.env.DB, c.req.param("id"), c.get("locale"));
  if (!doc) return c.json({ error: st(c.get("locale"), "errDocNotFound") }, 404);
  return c.json(doc satisfies KnowledgeDocFull);
});

// Створити власну нотатку. Ліміти — щоб корпус (він їде в КОЖЕН виклик чату) не розповзався.
knowledge.post("/knowledge", async (c) => {
  const { DOC_MAX_CHARS, USER_TOTAL_MAX_CHARS, userCharsExcept } = await import("../../lib/ai/knowledge/index.ts");
  const b = await c.req.json<{ title?: string; summary?: string; body?: string }>();
  const title = (b.title ?? "").trim();
  const body = (b.body ?? "").trim();
  if (!title) return c.json({ error: st(c.get("locale"), "errDocTitleRequired") }, 400);
  if (!body) return c.json({ error: st(c.get("locale"), "errDocEmpty") }, 400);
  if (body.length > DOC_MAX_CHARS) return c.json({ error: st(c.get("locale"), "errDocTooLong", { len: body.length, max: DOC_MAX_CHARS }) }, 400);
  const used = await userCharsExcept(c.env.DB);
  if (used + body.length > USER_TOTAL_MAX_CHARS) {
    return c.json({ error: st(c.get("locale"), "errCorpusFullEdit", { used: used + body.length, max: USER_TOTAL_MAX_CHARS }) }, 400);
  }
  const now = Math.floor(Date.now() / 1000);
  const id = `user:${now}:${Math.random().toString(36).slice(2, 7)}`;
  await knowledgeRepo.createUserDoc(
    c.env.DB, id, title, (b.summary ?? "").trim().slice(0, 200), body, now);
  return c.json({ ok: true, id });
});

// Зберегти: власну нотатку — як є; вбудований док — як override (крім locked).
knowledge.put("/knowledge/:id", async (c) => {
  const { KNOWLEDGE_DOCS, DOC_MAX_CHARS, USER_TOTAL_MAX_CHARS, userCharsExcept, isLocked } = await import("../../lib/ai/knowledge/index.ts");
  const id = c.req.param("id");
  const b = await c.req.json<{ title?: string; summary?: string; body?: string; enabled?: boolean }>();
  const base = KNOWLEDGE_DOCS.find((d) => d.id === id);
  // Канон розрахунків не редагується: інакше AI пояснював би цифри не так, як їх рахує код.
  if (isLocked(id)) return c.json({ error: st(c.get("locale"), "errDocLocked") }, 400);
  if (!base && !id.startsWith("user:")) return c.json({ error: st(c.get("locale"), "errDocNotFound") }, 404);

  const body = (b.body ?? "").trim();
  if (!body) return c.json({ error: st(c.get("locale"), "errDocEmpty") }, 400);
  if (body.length > DOC_MAX_CHARS) return c.json({ error: st(c.get("locale"), "errDocTooLong", { len: body.length, max: DOC_MAX_CHARS }) }, 400);
  if (!base) {
    const used = await userCharsExcept(c.env.DB, id);
    if (used + body.length > USER_TOTAL_MAX_CHARS) {
      return c.json({ error: st(c.get("locale"), "errCorpusFull", { used: used + body.length, max: USER_TOTAL_MAX_CHARS }) }, 400);
    }
  }
  const now = Math.floor(Date.now() / 1000);
  const title = (b.title ?? base?.title ?? "").trim();
  if (!title) return c.json({ error: st(c.get("locale"), "errDocTitleRequired") }, 400);
  const kind = base ? "override" : "user";
  const enabled = b.enabled === false ? 0 : 1;
  await knowledgeRepo.upsert(
    c.env.DB, id, kind, title, (b.summary ?? base?.summary ?? "").trim().slice(0, 200), body, enabled, now);
  return c.json({ ok: true, id });
});

// Видалити власну нотатку АБО повернути вбудований док до заводського тексту.
knowledge.delete("/knowledge/:id", async (c) => {
  const { isLocked } = await import("../../lib/ai/knowledge/index.ts");
  const id = c.req.param("id");
  if (isLocked(id)) return c.json({ error: st(c.get("locale"), "errDocCannotHide") }, 400);
  await knowledgeRepo.remove(c.env.DB, id);
  return c.json({ ok: true });
});
