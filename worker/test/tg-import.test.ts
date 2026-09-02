/**
 * §TG-CSV — a bank statement dropped into the chat.
 *
 * The whole feature is a dialogue, so what has to be pinned is the CONVERSATION: what the bot says
 * about a file before writing anything, which files it refuses and how, and — the part that
 * actually decides whether the numbers are right — that the account tap commits the mapping the
 * person was SHOWN, into the account they picked and no other.
 *
 * The harness is `telegram.test.ts`'s: `fetch` is replaced, calls to api.telegram.org are
 * recorded, and the observable behaviour is what the bot said. Here it also has to SERVE a file,
 * because `getFile` + the download are two more calls on the same host.
 */
import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { telegram } from "../routes/telegram.ts";
import { looksLikeStatement } from "../lib/messaging/tg-import.ts";
import { migratedDb, testEnv, type MemDb } from "./harness.ts";
import { seed } from "./fixture.ts";

const SECRET = "test-secret";
const CHAT = "424242";

const STATEMENT = [
  "Дата;Опис;Сума;MCC",
  "01.05.2026;Сільпо;-250,00;5411",
  "02.05.2026;Зарплата;10000,00;4829",
  "03.05.2026;Аптека;-100,00;5912",
].join("\n");

interface SentCall { method: string; body: Record<string, unknown> }

let sent: SentCall[] = [];
/** What the fake Telegram serves when the bot downloads the file. */
let fileBody = STATEMENT;
const realFetch = globalThis.fetch;

beforeEach(() => {
  sent = [];
  fileBody = STATEMENT;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes("api.telegram.org")) throw new Error(`unexpected fetch to ${url}`);
    // The DOWNLOAD is `/file/bot<token>/<path>` and is a plain GET — not an API method.
    if (url.includes("/file/bot")) return new Response(fileBody);
    const method = url.split("/").pop() ?? "";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    sent.push({ method, body });
    const result = method === "getFile" ? { file_path: "documents/statement.csv" } : { message_id: 7 };
    return new Response(JSON.stringify({ ok: true, result }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

afterEach(() => { globalThis.fetch = realFetch; });

function env(db: MemDb) {
  db.raw.prepare("INSERT OR REPLACE INTO app_state (key, value) VALUES ('tg_chat_id', ?)").run(CHAT);
  return { ...testEnv(db), TG_SECRET: SECRET, TG_BOT_TOKEN: "bot-token" };
}

async function send(e: Record<string, unknown>, update: unknown) {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => { pending.push(p); },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  const res = await telegram.request(`/${SECRET}`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": SECRET },
    body: JSON.stringify(update),
  }, e, ctx);
  await Promise.all(pending);
  return res;
}

const document = (o: Partial<{ file_name: string; mime_type: string; file_size: number }> = {}) => ({
  message: {
    message_id: 1,
    chat: { id: Number(CHAT) },
    from: { id: Number(CHAT) },
    document: { file_id: "f1", file_name: "statement.csv", ...o },
  },
});

const callback = (data: string) => ({
  callback_query: {
    id: "cb1", data, from: { id: Number(CHAT) },
    message: { message_id: 7, chat: { id: Number(CHAT) } },
  },
});

const texts = () => sent.filter((c) => c.method === "sendMessage" || c.method === "editMessageText")
  .map((c) => String(c.body.text));

const buttons = () => sent.flatMap((c) => {
  const kb = (c.body.reply_markup as { inline_keyboard?: { text: string; callback_data: string }[][] } | undefined)?.inline_keyboard;
  return (kb ?? []).flat();
});

// ---- which files are even statements ---------------------------------------------------------

test("§TG-CSV: a statement is recognised by EXTENSION, not by the type Telegram claims", () => {
  // Telegram reports a CSV as `application/vnd.ms-excel` often enough that trusting `mime_type`
  // would refuse the most common real file.
  assert.equal(looksLikeStatement({ file_id: "x", file_name: "вип.csv", mime_type: "application/vnd.ms-excel" }), true);
  assert.equal(looksLikeStatement({ file_id: "x", file_name: "a.TSV" }), true);
  assert.equal(looksLikeStatement({ file_id: "x", file_name: "звіт.pdf", mime_type: "text/plain" }), false,
    "a named .pdf is a .pdf whatever the type says");
  assert.equal(looksLikeStatement({ file_id: "x", mime_type: "text/csv" }), true, "no name — fall back to the type");
  assert.equal(looksLikeStatement({ file_id: "x", mime_type: "image/png" }), false);
});

test("§TG-CSV: a PDF is refused with an answer, not with silence", async () => {
  const db = migratedDb();
  seed(db);
  await send(env(db), document({ file_name: "виписка.pdf" }));
  // Nothing is downloaded and nothing is written; the person is told which formats work.
  assert.equal(sent.filter((c) => c.method === "getFile").length, 0);
  assert.match(texts().join("\n"), /CSV/);
});

// ---- the dialogue -----------------------------------------------------------------------------

test("§TG-CSV: a readable statement is SUMMARISED and asks which account — it writes nothing yet", async () => {
  const db = migratedDb();
  seed(db);
  const before = db.raw.prepare("SELECT COUNT(*) AS n FROM transactions").get() as { n: number };

  await send(env(db), document());

  const said = texts().join("\n");
  assert.match(said, /statement\.csv/, "the file is named back");
  assert.match(said, /3/, "three operations were read");
  // Choosing the account IS the confirmation, so the accounts have to be the buttons.
  const btns = buttons();
  assert.ok(btns.length > 0, "the bot offers accounts");
  assert.ok(btns.every((b) => b.callback_data.startsWith("imp_acc:")), "every button is an account choice");
  assert.ok(btns.some((b) => b.callback_data === "imp_acc:acc-uah"));

  const after = db.raw.prepare("SELECT COUNT(*) AS n FROM transactions").get() as { n: number };
  assert.equal(after.n, before.n, "the preview WRITES NOTHING — that is the whole point of it");
});

test("§TG-CSV: tapping an account imports into THAT account", async () => {
  const db = migratedDb();
  seed(db);
  const e = env(db);
  await send(e, document());
  sent = [];
  await send(e, callback("imp_acc:acc-usd"));

  const rows = db.raw.prepare(
    "SELECT account_id, COUNT(*) AS n FROM transactions WHERE source = 'import' GROUP BY account_id",
  ).all() as { account_id: string; n: number }[];
  assert.deepEqual(rows.map((r) => r.account_id), ["acc-usd"],
    "an import into the wrong account is wrong by a factor of forty and looks ordinary afterwards");
  assert.equal(rows[0].n, 3);
  assert.match(texts().join("\n"), /statement\.csv/);
});

test("§TG-CSV: the same file cannot be imported twice by tapping twice", async () => {
  const db = migratedDb();
  seed(db);
  const e = env(db);
  await send(e, document());
  await send(e, callback("imp_acc:acc-uah"));
  sent = [];
  // The pending record is cleared BEFORE the write, so the second tap has nothing to act on and
  // says so. Without it the person is told twice that it worked.
  await send(e, callback("imp_acc:acc-uah"));
  assert.match(texts().join("\n"), /уже опрацьовано|already handled/i);
});

test("§TG-CSV: a file whose columns cannot be read is refused, and names them", async () => {
  const db = migratedDb();
  seed(db);
  // No AI key, so §CSV-AI's fallback cannot run and the mapping stays incomplete — which is the
  // case this branch exists for.
  fileBody = "штука;річ;значення\nа;б;в\nг;д;е";
  const e = { ...env(db), ANTHROPIC_API_KEY: "" };
  await send(e, document());

  const said = texts().join("\n");
  // A chat cannot show a column picker; the refusal points at the screen that can.
  assert.match(said, /дата|date/i);
  assert.ok(!buttons().some((b) => b.callback_data.startsWith("imp_acc:")),
    "an unreadable file never offers to import");
  const imported = db.raw.prepare("SELECT COUNT(*) AS n FROM transactions WHERE source = 'import'").get() as { n: number };
  assert.equal(imported.n, 0);
});

test("§TG-CSV: a file too large for Telegram's own API is refused before any download", async () => {
  const db = migratedDb();
  seed(db);
  await send(env(db), document({ file_size: 25 * 1024 * 1024 }));
  assert.equal(sent.filter((c) => c.method === "getFile").length, 0,
    "`getFile` would fail at 20 MB with a status nobody can act on — say it first");
  assert.match(texts().join("\n"), /завелик|too large/i);
});
