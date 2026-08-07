// `/chats/*` — the transcript of the adviser chat, kept on the server.
//
// The ANSWER does not come from here: it streams from `/advisor/chat/stream`, which appends the
// assistant turn itself once it has one. This file owns everything else about a conversation —
// creating it, listing it, renaming, deleting, and the user's own turns.
//
// ⚠️ Ids come from the CLIENT, so every one of them is checked against `ID_RE` before it reaches
// SQL. The queries bind their parameters, so this is not what stands between us and injection —
// it is what stops a 4 MB string, or one id per keystroke, from becoming a row.
import { apiRoutes } from "./_shared.ts";
import * as repo from "../../repo/chats.ts";
import type { ChatDetail, ChatSummary } from "../../../shared/api/chats.ts";

export const chats = apiRoutes();

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_TITLE = 80;
// Same ceiling `normChatMessages` puts on a turn sent to the model: what we store and what the
// model is shown must not be able to disagree about how long a message may be.
const MAX_CONTENT = 8000;
const MAX_IMPORT_CHATS = 40;

const clean = (s: unknown, max: number) => (typeof s === "string" ? s.trim().slice(0, max) : "");
const now = () => Math.floor(Date.now() / 1000);

chats.get("/chats", async (c) => c.json(await repo.listChats(c.env.DB) satisfies ChatSummary[]));

/**
 * One-time adoption of the conversations that were living in `localStorage`.
 *
 * ⚠️ Registered ABOVE `/chats/:id` — Hono matches in order, so a literal below a parameterised
 * route of the same depth is simply unreachable (lint C7 checks this, and it was bought with a
 * real outage on `/transactions/frequent`).
 *
 * Idempotent by construction: the ids are the ones the old client generated, `INSERT OR IGNORE`
 * skips a conversation that is already here, and messages are only written for a chat this call
 * actually created. So running it from a second device adds that device's conversations and
 * leaves the rest alone, rather than doubling every line of every chat.
 */
chats.post("/chats/import", async (c) => {
  type ImportBody = { chats?: { id?: string; title?: string; updated_at?: number; messages?: unknown[] }[] };
  const body = await c.req.json<ImportBody>().catch((): ImportBody => ({}));
  const incoming = Array.isArray(body.chats) ? body.chats.slice(0, MAX_IMPORT_CHATS) : [];
  let imported = 0;

  for (const ch of incoming) {
    const id = typeof ch.id === "string" ? ch.id : "";
    if (!ID_RE.test(id)) continue;
    if (await repo.exists(c.env.DB, id)) continue;
    const turns = (Array.isArray(ch.messages) ? ch.messages : [])
      .filter((m): m is { role: string; content: string } =>
        !!m && typeof m === "object" && typeof (m as { content?: unknown }).content === "string")
      .map((m) => ({ role: m.role === "assistant" ? "assistant" as const : "user" as const, content: clean(m.content, MAX_CONTENT) }))
      .filter((m) => m.content);
    if (!turns.length) continue;   // an empty draft chat is not worth carrying across

    const at = Number.isFinite(ch.updated_at) ? Math.floor(Number(ch.updated_at) / 1000) : now();
    await repo.create(c.env.DB, id, clean(ch.title, MAX_TITLE) || "Chat", at);
    for (const t of turns) await repo.append(c.env.DB, id, t.role, t.content, at);
    imported++;
  }
  return c.json({ imported });
});

chats.get("/chats/:id", async (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return c.json({ error: "bad id" }, 400);
  const list = await repo.listChats(c.env.DB);
  const head = list.find((x) => x.id === id);
  if (!head) return c.json({ error: "not found" }, 404);
  return c.json({ ...head, messages: await repo.messages(c.env.DB, id) } satisfies ChatDetail);
});

chats.post("/chats", async (c) => {
  const b = await c.req.json<{ id?: string; title?: string }>().catch(() => ({} as { id?: string; title?: string }));
  const id = typeof b.id === "string" ? b.id : "";
  if (!ID_RE.test(id)) return c.json({ error: "bad id" }, 400);
  await repo.create(c.env.DB, id, clean(b.title, MAX_TITLE) || "Chat", now());
  return c.json({ ok: true });
});

chats.patch("/chats/:id", async (c) => {
  const id = c.req.param("id");
  const b = await c.req.json<{ title?: string }>().catch(() => ({} as { title?: string }));
  const title = clean(b.title, MAX_TITLE);
  if (!ID_RE.test(id) || !title) return c.json({ error: "bad request" }, 400);
  await repo.rename(c.env.DB, id, title);
  return c.json({ ok: true });
});

chats.delete("/chats/:id", async (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return c.json({ error: "bad id" }, 400);
  await repo.remove(c.env.DB, id);
  return c.json({ ok: true });
});

/**
 * Append the user's own turn.
 *
 * Only `user` is accepted: the assistant turn is written by the endpoint that produced it, and a
 * client allowed to post one could put words in the adviser's mouth — which the model would then
 * read back as its own reasoning on the next question.
 */
chats.post("/chats/:id/messages", async (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return c.json({ error: "bad id" }, 400);
  const b = await c.req.json<{ content?: string; title?: string }>().catch(() => ({} as { content?: string; title?: string }));
  const content = clean(b.content, MAX_CONTENT);
  if (!content) return c.json({ error: "content required" }, 400);
  // The first question is also what names the conversation, so creating and appending is one
  // round trip: a rail row that exists without the message that justifies it is a ghost.
  await repo.create(c.env.DB, id, clean(b.title, MAX_TITLE) || content.slice(0, 40), now());
  await repo.append(c.env.DB, id, "user", content, now());
  return c.json({ ok: true });
});

/** Regenerate: drop everything after the first `keep` turns, then the stream writes a new reply. */
chats.post("/chats/:id/truncate", async (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return c.json({ error: "bad id" }, 400);
  const keep = Number((await c.req.json<{ keep?: number }>().catch(() => ({} as { keep?: number }))).keep);
  if (!Number.isFinite(keep) || keep < 0) return c.json({ error: "keep required" }, 400);
  await repo.truncate(c.env.DB, id, Math.floor(keep));
  return c.json({ ok: true });
});
