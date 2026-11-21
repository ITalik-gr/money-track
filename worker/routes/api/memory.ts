// `/memory/*` — the user's view of what the assistant remembers (§MEMORY): see it, correct it,
// pin it, forget it. Memory that cannot be inspected is memory nobody should trust.
import { apiRoutes, idParam } from "./_shared.ts";
import { st } from "../../lib/platform/i18n.ts";
import { isDemoEnv } from "../../lib/platform/demo.ts";
import {
  addUserMemory, deleteMemory, memoryList, patchMemory,
} from "../../lib/ai/memory.ts";
import type { MemoryList } from "../../../shared/api/memory.ts";

export const memory = apiRoutes();

memory.get("/memory", async (c) => c.json(await memoryList(c.env) satisfies MemoryList));

memory.post("/memory", async (c) => {
  if (isDemoEnv(c.env)) return c.json({ error: st(c.get("locale"), "errMemoryDemo") }, 403);
  const b = await c.req.json<{ text?: unknown; horizon?: unknown; valid_until?: unknown }>().catch(() => ({}));
  const id = await addUserMemory(c.env, b);
  if (id == null) return c.json({ error: st(c.get("locale"), "errMemoryText") }, 400);
  return c.json({ id });
});

memory.patch("/memory/:id", async (c) => {
  if (isDemoEnv(c.env)) return c.json({ error: st(c.get("locale"), "errMemoryDemo") }, 403);
  const id = idParam(c);
  if (id == null) return c.json({ error: st(c.get("locale"), "errBadId") }, 400);
  const b = await c.req.json<{ pinned?: unknown; text?: unknown; status?: unknown }>().catch(() => ({}));
  const out = await patchMemory(c.env, id, b);
  if (out === "not_found") return c.json({ error: "not found" }, 404);
  if (out === "bad_text") return c.json({ error: st(c.get("locale"), "errMemoryText") }, 400);
  if (out === "topic_taken") return c.json({ error: st(c.get("locale"), "errMemoryTopic") }, 409);
  return c.json({ ok: true });
});

memory.delete("/memory/:id", async (c) => {
  const id = idParam(c);
  if (id == null) return c.json({ error: st(c.get("locale"), "errBadId") }, 400);
  await deleteMemory(c.env, id);
  return c.json({ ok: true });
});
