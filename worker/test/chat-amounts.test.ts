import test from "node:test";
import assert from "node:assert/strict";
import { splitAmounts } from "../../src/lib/amount-spans.ts";

const spans = (s: string) => splitAmounts(s, (x) => x).filter((p) => p.amount).map((p) => p.text);

test("a range is one highlighted amount", () => {
  assert.deepEqual(spans("Реально: 26 000- 32 500₴ на місяць"), ["26 000- 32 500₴"]);
  assert.deepEqual(spans("від 26 000–32 500 грн"), ["26 000–32 500 грн"]);
  assert.deepEqual(spans("ставка 5%-10%"), ["5%-10%"]);
  assert.deepEqual(spans("$1 200–1 500 за місяць"), ["$1 200–1 500"]);
});

test("scale words and crypto units stay inside the amount", () => {
  assert.deepEqual(spans("близько 30 тис ₴"), ["30 тис ₴"]);
  assert.deepEqual(spans("тримаєш 0.0345 BTC і 120 USDT"), ["0.0345 BTC", "120 USDT"]);
});

test("a year is not glued to the amount after it", () => {
  assert.deepEqual(spans("у 2026 120 ₴"), ["120 ₴"]);
});

test("plain numbers, dates and words are left alone", () => {
  assert.deepEqual(spans("за 3 місяці, 2026-11-21, 12 операцій"), []);
  assert.deepEqual(spans("model5%x"), []);
});

test("the text survives the split unchanged", () => {
  const s = "Було 1 200 ₴, стало 26 000–32 500₴ (+15%).";
  assert.equal(splitAmounts(s, (x) => x).map((p) => p.text).join(""), s);
});

test("a chart block keeps its type, series and real values only", async () => {
  const { parseChart } = await import("../../src/lib/chart-block.ts");
  const c = parseChart("line|Тренд", ["#|Витрати|Дохід", "Вер|4 500|6000", "Жов|3200|", "Лис|−300 ₴|6100"]);
  assert.equal(c?.type, "line");
  assert.deepEqual(c?.series, ["Витрати", "Дохід"]);
  assert.deepEqual(c?.rows.map((r) => r.values), [[4500, 6000], [-300, 6100]]);
  assert.equal(parseChart("Старий заголовок", ["A|1"])?.type, "bar");
  assert.equal(parseChart("donut|Частки", ["A|5", "B|-1"])?.type, "bar");
  assert.equal(parseChart("line|Порожньо", ["A|немає"]), null);
});

test("§CHAT-IMG: images are per-user, typed by content, and only the newest reach the model", async () => {
  const { hydrateChatImages, sniffImageType, storeChatImage, readChatImage, deleteChatImages } = await import("../lib/ai/chat-images.ts");
  const store = new Map<string, Uint8Array>();
  const RECEIPTS = {
    put: async (k: string, v: Uint8Array) => { store.set(k, v); },
    get: async (k: string) => { const v = store.get(k); return v ? { arrayBuffer: async () => v.slice().buffer } : null; },
    delete: async (keys: string[]) => { for (const k of keys) store.delete(k); },
  };
  const env = (USER_ID: string) => ({ USER_ID, RECEIPTS }) as never;
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  assert.equal(sniffImageType(png), "image/png");
  assert.equal(sniffImageType(new TextEncoder().encode("<svg onload=x>")), null);

  const ids = [];
  for (let i = 0; i < 4; i++) ids.push(await storeChatImage(env("a"), png, "image/png"));
  assert.equal(await readChatImage(env("b"), ids[0]), null, "another user's id resolves to nothing");

  const turns = [{ role: "user" as const, content: `${ids.map((id) => `[img:${id}]`).join(" ")}\nщо тут?` }];
  const [hydrated] = await hydrateChatImages(env("a"), turns);
  const blocks = hydrated.blocks as { type: string; text?: string }[];
  assert.equal(blocks.filter((b) => b.type === "image").length, 3);
  assert.equal(blocks.at(-1)?.text, "що тут?");

  await deleteChatImages(env("a"), turns);
  assert.equal(store.size, 0);
});

test("amounts written the way people write them", () => {
  assert.deepEqual(spans("$2,162.84"), ["$2,162.84"]);
  assert.deepEqual(spans("треба 5-6к і ще ~31-37 тис"), ["5-6к", "31-37 тис"]);
  assert.deepEqual(spans("десь 2,4к на місяць"), ["2,4к"]);
  assert.deepEqual(spans("3 к нам, 27-го, 3-6 місяців"), []);
});

test("the adviser's window keeps a long chat and opens on a question", async () => {
  const { normChatMessages, ADVISOR_CHAT_TURNS } = await import("../routes/api/_shared.ts");
  const chat = Array.from({ length: 17 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i}` }));
  assert.equal(normChatMessages(chat, ADVISOR_CHAT_TURNS).length, 17);
  const short = normChatMessages(chat);
  assert.equal(short[0].role, "user");
  assert.equal(short.at(-1)?.content, "turn 16");
  const huge = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "x".repeat(8000) }));
  assert.ok(normChatMessages(huge, ADVISOR_CHAT_TURNS).reduce((n, t) => n + t.content.length, 0) <= 80_000);
});

test("a saved answer carries no narration from before a server tool", async () => {
  const { runToolConversation } = await import("../lib/ai/ai.ts");
  const real = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({
    stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
    content: [
      { type: "text", text: "Let me check the rate." },
      { type: "server_tool_use", id: "s1", name: "web_search", input: {} },
      { type: "web_search_tool_result", tool_use_id: "s1", content: [] },
      { type: "text", text: "The answer " }, { type: "text", text: "in two blocks." },
    ],
  })) as unknown as typeof fetch;
  try {
    const db = { prepare: () => ({ bind() { return this; }, first: async () => null, run: async () => ({}), all: async () => ({ results: [] }) }) };
    const env = { ANTHROPIC_API_KEY: "test", DB: db } as never;
    const { text } = await runToolConversation(env, [], [{ role: "user", content: "q" }], [], async () => ({}), 100, "claude-sonnet-5-5");
    assert.equal(text, "The answer in two blocks.");
  } finally { globalThis.fetch = real; }
});
