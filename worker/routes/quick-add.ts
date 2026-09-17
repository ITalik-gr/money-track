// §QUICK-ADD — transport for the phone shortcut. Authenticated in the Worker (`quickAddGuard`);
// by the time a request is here it is already addressed to this user's object.
import { Hono } from "hono";
import type { Env } from "../env.ts";
import { quickAddTx } from "../services/quick-add.ts";
import type { QuickAddBody } from "../../shared/api/platform.ts";

export const quickAdd = new Hono<{ Bindings: Env }>();

quickAdd.post("/", async (c) => {
  // Shortcuts' «Get Contents of URL» sends JSON or a form, depending on how it was set up.
  const type = c.req.header("content-type") ?? "";
  const b: QuickAddBody = type.includes("json")
    ? await c.req.json<QuickAddBody>().catch(() => ({}))
    : Object.fromEntries((await c.req.formData().catch(() => new FormData())).entries()) as QuickAddBody;
  if (b.income != null && typeof b.income !== "boolean") b.income = String(b.income) === "true";
  const res = await quickAddTx(c.env, b);
  return c.json(res, res.ok ? 200 : 400);
});
