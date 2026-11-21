/**
 * §CHAT-IMG — pictures in the adviser chat (a portfolio screenshot, a bill, a photo).
 *
 * A turn stores only a `[img:<uuid>]` marker; the bytes live in R2 under the user's own prefix, so
 * ownership is the path and a guessed id from another account resolves to nothing. Base64 in
 * `chat_messages` was rejected: it would bloat every transcript read and every nightly backup.
 */
import type { Env } from "../../env.ts";
import type { ChatMsg } from "./ai.ts";
import { toBase64 } from "./receipt.ts";

export const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024;
/** Newest images resent to the model per request: each one is billed again on every turn. */
const MAX_IMAGES_IN_CONTEXT = 3;
const MARKER = /\[img:([0-9a-f-]{36})\]/g;
export const CHAT_IMAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const keyOf = (env: Env, id: string) =>
  `chat-images/${(env.USER_ID ?? "unknown").replace(/[^a-zA-Z0-9:_-]/g, "")}/${id}`;

/** By content, never by the client's header: the type is echoed back when the image is served. */
export function sniffImageType(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return "image/webp";
  return null;
}

export async function storeChatImage(env: Env, bytes: Uint8Array, type: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.RECEIPTS.put(keyOf(env, id), bytes, { httpMetadata: { contentType: type } });
  return id;
}

export const readChatImage = (env: Env, id: string) => env.RECEIPTS.get(keyOf(env, id));

export const imageIdsIn = (text: string) => [...text.matchAll(MARKER)].map((m) => m[1]);

export async function deleteChatImages(env: Env, turns: { content: string }[]): Promise<void> {
  const keys = turns.flatMap((t) => imageIdsIn(t.content)).map((id) => keyOf(env, id));
  if (keys.length) await env.RECEIPTS.delete(keys);
}

/** Turns markers into vision blocks for the newest images; older ones stay a short text note. */
export async function hydrateChatImages(env: Env, turns: ChatMsg[]): Promise<ChatMsg[]> {
  const wanted = new Set(turns.filter((t) => t.role === "user").flatMap((t) => imageIdsIn(t.content)).slice(-MAX_IMAGES_IN_CONTEXT));
  return Promise.all(turns.map(async (t) => {
    const ids = t.role === "user" ? imageIdsIn(t.content) : [];
    if (!ids.length) return t;
    const blocks: unknown[] = [];
    for (const id of ids) {
      const obj = wanted.has(id) ? await readChatImage(env, id) : null;
      if (!obj) { blocks.push({ type: "text", text: "(an image attached earlier is no longer in view)" }); continue; }
      const bytes = new Uint8Array(await obj.arrayBuffer());
      blocks.push({ type: "image", source: { type: "base64", media_type: sniffImageType(bytes) ?? "image/jpeg", data: toBase64(bytes) } });
    }
    const text = t.content.replace(MARKER, "").trim();
    blocks.push({ type: "text", text: text || "Analyse the attached image in the context of my finances." });
    return { ...t, blocks };
  }));
}
