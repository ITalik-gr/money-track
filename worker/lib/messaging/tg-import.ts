/**
 * §TG-CSV (2026-09-02) — a bank statement, dropped into the chat.
 *
 * WHY THIS AND NOT A SECOND IMPORTER. Everything that decides what gets imported already lives in
 * `lib/bank/statement-import.ts`, and this file adds exactly two things: getting the bytes out of
 * Telegram, and turning a web form into a conversation. It parses nothing and writes nothing
 * itself. That is the point — the mapping the person approves in the chat has to be the mapping
 * that gets committed, and the only way to guarantee it is for both halves to be the same code.
 *
 * ⚠️ **THE PREVIEW IS A DIALOGUE, NOT A BUTTON.** This is the part the roadmap card flagged as
 * needing thought, and the answer is that a chat cannot show a column picker — so the flow splits
 * by whether the file needs one:
 *
 *   · the mapping is COMPLETE → the bot says what it understood (rows, window, duplicates, what it
 *     will skip and why) and asks WHICH ACCOUNT. Choosing the account is the confirmation; there
 *     is nothing else the person could usefully decide from a phone.
 *   · the mapping is INCOMPLETE → the bot refuses and links to the web import, naming the columns
 *     it could not find. Offering a text-based column picker over a chat would be a worse version
 *     of a screen that already exists, and getting it wrong writes a month of wrong numbers.
 *
 * ⚠️ **The pending record stores the `file_id`, never the file.** Telegram already holds the bytes
 * and a `file_id` is a stable handle to them, so a 4 MB statement does not have to sit in the
 * object's SQLite between two taps. What IS stored is the resolved MAPPING — because re-resolving
 * it at commit could reach `mapStatementColumns` a second time and answer differently, importing
 * columns the person never saw. Same rule as the web preview, one surface over.
 *
 * ⚠️ **The account is never guessed.** An import into the wrong account stores every amount in the
 * wrong currency (a USD statement into a hryvnia account is wrong by a factor of forty) and looks
 * completely ordinary afterwards, with no trace that the file said otherwise. One account is still
 * asked about — a person with one account is exactly the person who would not notice.
 */
import type { Env } from "../../env.ts";
import { getState, setState } from "../finance/repo.ts";
import { st, resolveLocale, type ServerLocale } from "../platform/i18n.ts";
import { editMessageText, sendChatAction, sendMessage, type InlineKeyboard } from "./telegram.ts";
import { escapeHtml } from "./tg-format.ts";
import { previewStatement, commitStatement, MAX_CHARS } from "../bank/statement-import.ts";
import type { ColumnMapping } from "../bank/providers/csv.ts";
import { listActive as listAccounts } from "../../repo/accounts.ts";

/** Telegram's Bot API refuses `getFile` above 20 MB, so a larger file cannot be fetched at all —
 *  say so instead of failing at the download with a status code nobody can act on. */
const TG_MAX_FILE = 20 * 1024 * 1024;

/** What survives between "here is what I understood" and the account tap. */
interface PendingImport {
  file_id: string;
  file_name: string;
  delimiter: string;
  mapping: Partial<ColumnMapping>;
  message_id: number;
}

const key = (chatId: number) => `tg_import:${chatId}`;

/** The document, as Telegram describes it in the update. */
export interface TgDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

/**
 * A statement is TEXT, and Telegram will not say which encoding.
 *
 * UTF-8 with a BOM is what a Ukrainian bank's export usually is, and the BOM has to go or it
 * becomes part of the first header cell — which is exactly the kind of thing that makes
 * `guessMapping` miss a column it would otherwise have recognised.
 */
async function fetchText(token: string, fileId: string): Promise<string> {
  const { getFileBytes } = await import("./telegram.ts");
  const { bytes } = await getFileBytes(token, fileId);
  const text = new TextDecoder("utf-8").decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Looks like a statement? Extension first — Telegram's `mime_type` for a CSV is frequently
 *  `application/vnd.ms-excel`, which is neither true nor useful. */
export function looksLikeStatement(doc: TgDocument): boolean {
  const name = (doc.file_name ?? "").toLowerCase();
  if (/\.(csv|tsv|txt)$/.test(name)) return true;
  // No name at all: fall back to the type, but only for the ones that are genuinely text.
  return !name && /^text\//.test(doc.mime_type ?? "");
}

const fmtDay = (t: number, locale: ServerLocale) =>
  new Date(t * 1000).toLocaleDateString(locale === "en" ? "en-US" : "uk-UA", { day: "2-digit", month: "short", year: "numeric" });

async function accountKeyboard(env: Env): Promise<InlineKeyboard> {
  const accounts = await listAccounts(env.DB);
  return accounts.map((a) => [{
    text: `${a.title ?? a.id}`,
    callback_data: `imp_acc:${a.id}`,
  }]);
}

/**
 * A statement arrived. Download it, run the SAME preview the web import runs, and report.
 */
export async function handleDocument(env: Env, chatId: number, doc: TgDocument, origin?: string): Promise<void> {
  const token = env.TG_BOT_TOKEN;
  const locale = await resolveLocale(env);

  if (!looksLikeStatement(doc)) {
    await sendMessage(token, chatId, st(locale, "tgImportNotCsv"));
    return;
  }
  if ((doc.file_size ?? 0) > TG_MAX_FILE) {
    await sendMessage(token, chatId, st(locale, "tgImportTooBig"));
    return;
  }
  await sendChatAction(token, chatId, "typing");

  let text: string;
  try {
    text = await fetchText(token, doc.file_id);
  } catch {
    await sendMessage(token, chatId, st(locale, "tgImportDownloadFailed"));
    return;
  }
  if (text.length > MAX_CHARS) {
    await sendMessage(token, chatId, st(locale, "tgImportTooBig"));
    return;
  }

  const p = await previewStatement(env, text);
  if ("error" in p) {
    await sendMessage(token, chatId, st(locale, "tgImportUnreadable"));
    return;
  }

  const importUrl = origin ? `${origin}/settings` : "";
  if (!p.complete) {
    // A chat is the wrong place to pick columns — the web import already has a screen for it, and
    // guessing here writes a month of wrong numbers that nobody re-reads a statement to catch.
    const missing = [
      p.mapping.date == null ? st(locale, "tgImportColDate") : null,
      p.mapping.amount == null ? st(locale, "tgImportColAmount") : null,
      p.mapping.description == null ? st(locale, "tgImportColDesc") : null,
    ].filter(Boolean).join(", ");
    await sendMessage(token, chatId, st(locale, "tgImportIncomplete", { missing, url: importUrl }));
    return;
  }

  const accounts = await accountKeyboard(env);
  if (!accounts.length) {
    await sendMessage(token, chatId, st(locale, "tgImportNoAccounts"));
    return;
  }

  // What the bot understood, in the order a person checks it: how much, from when, and what it is
  // about to NOT import. The skipped count is stated up front rather than after the write —
  // «імпортовано 0 з 300» after the fact reads as a failure when it is a correct no-op.
  const lines = [
    st(locale, "tgImportHead", { name: escapeHtml(doc.file_name ?? "CSV"), n: p.parsed ?? 0 }),
  ];
  if (p.first_time && p.last_time) {
    lines.push(st(locale, "tgImportWindow", { from: fmtDay(p.first_time, locale), to: fmtDay(p.last_time, locale) }));
  }
  if (p.skipped_total) lines.push(st(locale, "tgImportSkipped", { n: p.skipped_total }));
  // A mapping the model proposed is a GUESS, and one that does not admit to being one is the kind
  // that gets approved without a look (§CSV-AI).
  if (p.mapping_source === "ai") lines.push(st(locale, "tgImportAiMapping"));
  lines.push("");
  lines.push(st(locale, "tgImportPickAccount"));

  const sent = await sendMessage(token, chatId, lines.join("\n"), accounts);
  const pending: PendingImport = {
    file_id: doc.file_id,
    file_name: doc.file_name ?? "CSV",
    delimiter: p.delimiter,
    mapping: p.mapping,
    message_id: sent.message_id,
  };
  await setState(env.DB, key(chatId), JSON.stringify(pending));
}

/**
 * The account was tapped. Re-download and commit — with the mapping the person was SHOWN.
 *
 * Returns false when this callback is not ours, so the router can keep looking.
 */
export async function handleImportCallback(
  env: Env, chatId: number, messageId: number, cbId: string, data: string,
): Promise<boolean> {
  if (!data.startsWith("imp_acc:")) return false;
  const token = env.TG_BOT_TOKEN;
  const locale = await resolveLocale(env);
  const { answerCallbackQuery } = await import("./telegram.ts");

  const raw = await getState(env.DB, key(chatId));
  const p: PendingImport | null = raw ? JSON.parse(raw) : null;
  if (!p) {
    // The bot restarted, or the file was answered twice. Say which, rather than failing silently:
    // a tap that does nothing is indistinguishable from a tap that did something.
    await answerCallbackQuery(token, cbId, st(locale, "tgImportStale"));
    await editMessageText(token, chatId, messageId, st(locale, "tgImportStale"));
    return true;
  }

  const accountId = data.slice("imp_acc:".length);
  // Cleared BEFORE the write, not after: the commit takes seconds over a large file, and a second
  // tap in that window would import the same statement twice. The content hash in `upsertCanonicalTx`
  // would swallow the duplicate rows, but the person would be told twice that it worked.
  await setState(env.DB, key(chatId), "");
  await answerCallbackQuery(token, cbId);
  await editMessageText(token, chatId, messageId, st(locale, "tgImportWorking", { name: escapeHtml(p.file_name) }));

  try {
    const text = await fetchText(token, p.file_id);
    const r = await commitStatement(env, text, accountId, {
      delimiter: p.delimiter,
      // The mapping the confirmation was BUILT from, not a fresh resolution: `resolveMapping` can
      // reach the model, and a model asked twice may answer differently — importing columns the
      // person never approved.
      mapping: p.mapping,
    });
    if ("error" in r) {
      await editMessageText(token, chatId, messageId, st(locale, "tgImportFailed"));
      return true;
    }
    await editMessageText(token, chatId, messageId, st(locale, "tgImportDone", {
      name: escapeHtml(p.file_name),
      inserted: r.inserted,
      duplicates: r.duplicates,
      skipped: r.skipped,
    }));
  } catch {
    await editMessageText(token, chatId, messageId, st(locale, "tgImportFailed"));
  }
  return true;
}
