/**
 * MCP server — the ledger, exposed to an MCP client (Claude Code, Claude Desktop) as tools.
 *
 * WHY IT LIVES INSIDE THE DURABLE OBJECT, like everything else that touches money: the tools it
 * exposes are `lib/ai/chat-tools.ts`, whose queries run against `env.DB`. Placing the JSON-RPC
 * handler in the Worker would have meant a remote `db` proxy per query — the exact cost
 * `user-app.ts` explains at length. The Worker's half is authentication and nothing else.
 *
 * WHY IT REUSES THE CHAT'S TOOLS RATHER THAN DECLARING ITS OWN. The in-app adviser already has a
 * query API a model calls back into, with schemas and an executor kept adjacent so a mismatch is
 * visible. A second set written for MCP would be the same concept with two implementations,
 * drifting exactly where nobody looks — §CUR-PLAN, §A1-WRITE and §INGEST-WRITE are all that same
 * bug, found late. So the tool list here is a FILTER over `financeChatTools()` plus one addition,
 * and `tools/call` dispatches into `runFinanceTool`.
 *
 * ⚠️ Read-only by construction (`financeReadTools`). `remember_fact` writes a proposal that can
 * later move burn and runway once confirmed; a token living in a config file on a laptop is a
 * credential for LOOKING at the ledger.
 *
 * Transport: Streamable HTTP with a JSON response (the SSE stream is optional in the spec and
 * buys nothing here — every tool answers in one shot). No `Mcp-Session-Id`: the server keeps no
 * per-connection state, so there is no session to resume and nothing to expire.
 */
import { Hono } from "hono";
import type { Env } from "../env.ts";
import { financeReadTools, runFinanceTool } from "../lib/ai/chat-tools.ts";
import { collectFinanceSnapshot } from "../lib/ai/advisor.ts";

export const mcp = new Hono<{ Bindings: Env }>();

/**
 * Protocol versions this server can speak, newest first.
 *
 * A client states the version it wants in `initialize`; the spec says to answer with the same one
 * when it is supported and with our own latest when it is not, and to let the client decide
 * whether it can live with that. All three listed here differ only in ways this server does not
 * use (batching, elicitation, resource links), so accepting the older ones costs nothing and
 * keeps an older Claude Desktop from failing the handshake outright.
 */
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

/** What the model is told this server is for, once, at connection time. */
const INSTRUCTIONS = [
  "Money Track — the user's own personal finance ledger (bank transactions, categories, budgets,",
  "subscriptions, goals). Every figure comes from their real data.",
  "",
  "Call `get_finance_snapshot` first for questions about their overall position — it returns the",
  "cash cushion, debt, investments, the canonical monthly burn and runway, budgets, subscriptions",
  "and a 6-month trend in one call, computed by the same code the app's own screens use.",
  "Use `query_spend` for totals over a period and `find_transactions` for individual operations.",
  "Call `list_categories` when unsure of a category's exact name — filtering by a name the user",
  "does not have returns nothing, which reads as 'you have no such spending'.",
  "",
  "AMOUNTS ARE WHOLE CURRENCY UNITS across every tool here (a `_uah` suffix is historical and",
  "does NOT mean hryvnia — each answer states its own `currency` code). Never convert an amount",
  "into another currency, and never restate one with a different sign than the stated code.",
].join("\n");

const SNAPSHOT_TOOL = {
  name: "get_finance_snapshot",
  description:
    "The user's whole financial position right now: cash cushion, debt, investments, net worth, " +
    "canonical monthly burn and runway, top categories and merchants over 90 days, budgets, " +
    "subscriptions and upcoming charges, a 6-month trend, and one-off vs recurring spending. " +
    "This is the same snapshot the in-app adviser is given, so its figures match the app's screens. " +
    "Call it for any question about how they are doing overall, what they can afford, or whether " +
    "something is affordable.",
  // Same strictness as every other tool: an explicit `required` and a closed object. A schema a
  // client rejects means, to that client, that the tool does not exist — no error, just an
  // assistant that answers as though it cannot see the ledger (`chat-tools.ts` → `strict`).
  inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
};

/**
 * The snapshot, in the SAME unit as every other tool here.
 *
 * `collectFinanceSnapshot` returns two things at once: top-level fields in MINOR units
 * (`ownFunds`, `monthlyBurn` — the adviser's own arithmetic) and a `context` object whose every
 * money field is already divided by 100 and suffixed `_uah`. Handing both to a client would put
 * two units, differing by 100×, inside one answer — and the reader most likely to spot it is the
 * one holding the smaller number. So only `context` crosses the wire: it is internally
 * consistent, it carries the notes that say what each block means, and it is exactly what the
 * in-app adviser is given, which is what keeps MCP figures equal to the app's own screens.
 *
 * The currency is stated as DATA rather than left to a key name, for the reason §BASE-CUR gives:
 * a model handed a general instruction and a specific contradicting field believes the field.
 */
async function snapshot(env: Env): Promise<unknown> {
  const snap = await collectFinanceSnapshot(env);
  const { currencyCode } = await import("../../shared/currency.ts");
  const { resolveBaseCurrency } = await import("../lib/finance/money.ts");
  return { currency: currencyCode(await resolveBaseCurrency(env)), as_of: snap.now, ...snap.context };
}

interface RpcRequest { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> }

function ok(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}
function fail(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** A tool's answer, in the one shape every MCP client knows how to render. */
function toolText(value: unknown, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError };
}

async function handleRpc(env: Env, req: RpcRequest): Promise<unknown | null> {
  const { id, method } = req;
  const params = req.params ?? {};

  switch (method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return ok(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "money-track", title: "Money Track", version: "1.0.0" },
        instructions: INSTRUCTIONS,
      });
    }

    // Notifications carry no id and get no response — the caller turns `null` into a 202.
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return ok(id, {});

    case "tools/list":
      return ok(id, { tools: [SNAPSHOT_TOOL, ...financeReadTools().map((t) => ({
        name: t.name, description: t.description, inputSchema: t.input_schema,
      }))] });

    /**
     * Deliberately answered with empty lists rather than "method not found", even though neither
     * capability is advertised. Some clients probe for both on connect regardless, and a
     * `-32601` there surfaces in their logs as an error about a server that is working fine —
     * a false alarm is worse than an empty list.
     */
    case "resources/list":
      return ok(id, { resources: [] });
    case "resources/templates/list":
      return ok(id, { resourceTemplates: [] });
    case "prompts/list":
      return ok(id, { prompts: [] });

    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (name === SNAPSHOT_TOOL.name) return ok(id, toolText(await snapshot(env)));
      /**
       * The gate is `financeReadTools()`, not a check against the whole tool table: the list a
       * client was SHOWN is the list it may call. Dispatching on `runFinanceTool` alone would
       * expose `remember_fact` to anyone who guessed the name, since that executor answers every
       * tool the chat has.
       */
      if (!financeReadTools().some((t) => t.name === name)) {
        return ok(id, toolText({ error: `unknown tool: ${name}` }, true));
      }
      /**
       * A failing tool is reported INSIDE the result (`isError`), not as a JSON-RPC error: the
       * protocol layer did its job, and a model that sees the message can correct its own call
       * (a bad date, a category that does not exist). A transport-level error is invisible to it.
       */
      try {
        return ok(id, toolText(await runFinanceTool(env, name, args)));
      } catch (e) {
        return ok(id, toolText({ error: e instanceof Error ? e.message : String(e) }, true));
      }
    }

    default:
      return fail(id, -32601, `method not found: ${method ?? "(none)"}`);
  }
}

mcp.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body === null) return c.json(fail(null, -32700, "parse error"), 400);

  // JSON-RPC batching exists in 2024-11-05/2025-03-26 and was removed in 2025-06-18. Handled
  // rather than refused, because the version a client picks is the client's business.
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handleRpc(c.env, m as RpcRequest)))).filter((r) => r !== null);
    return out.length ? c.json(out) : c.body(null, 202);
  }
  const res = await handleRpc(c.env, body as RpcRequest);
  return res === null ? c.body(null, 202) : c.json(res);
});

/**
 * The GET half of Streamable HTTP opens a server→client event stream. This server never initiates
 * anything (no sampling, no progress, no list-changed), so it declines instead of holding an idle
 * connection open for the life of the client — which on Cloudflare is a billed one.
 */
mcp.get("/", (c) => c.json(fail(null, -32601, "this server does not offer an event stream"), 405));
