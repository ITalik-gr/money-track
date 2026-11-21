import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatImageUpload } from "../../../shared/api/chats.ts";
import { localeHeaders, translate } from "../../i18n/index.ts";
import { getLocale } from "../../i18n/locale.ts";
import { errText } from "../../lib/errors.ts";

const MAX_IMAGES = 4;
// The long edge the vision model works at; anything larger is downscaled by the API anyway, after
// being paid for in upload time on a phone connection.
const MAX_EDGE = 1568;

export interface PendingImage { key: string; url: string; id?: string }

async function shrink(file: File): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * k);
  canvas.height = Math.round(bmp.height * k);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  // WebP, not JPEG: it keeps alpha (a transparent screenshot would turn black behind its text) and
  // small figures stay sharp. Safari cannot encode it and falls back to PNG, which the server accepts.
  return new Promise((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error("encode"))), "image/webp", 0.92));
}

async function upload(blob: Blob): Promise<string> {
  const res = await fetch("/api/chats/images", {
    method: "POST", headers: localeHeaders({ "content-type": blob.type }), body: blob,
  });
  const data = await res.json().catch(() => null) as (ChatImageUpload & { error?: string }) | null;
  if (!res.ok || !data?.id) throw Object.assign(new Error(data?.error ?? `HTTP ${res.status}`), { status: res.status, data });
  return data.id;
}

/** The composer's pictures: each uploads as soon as it is picked, so sending never waits on it. */
export function useChatImages() {
  const [items, setItems] = useState<PendingImage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(items);
  live.current = items;
  useEffect(() => () => { for (const p of live.current) URL.revokeObjectURL(p.url); }, []);

  const remove = useCallback((key: string) => {
    setItems((prev) => {
      const hit = prev.find((p) => p.key === key);
      if (hit) URL.revokeObjectURL(hit.url);
      return prev.filter((p) => p.key !== key);
    });
  }, []);

  const clear = useCallback(() => {
    for (const p of live.current) URL.revokeObjectURL(p.url);
    setItems([]);
    setError(null);
  }, []);

  const add = useCallback((list: FileList | null) => {
    const files = [...(list ?? [])].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    setError(null);
    const room = MAX_IMAGES - live.current.length;
    if (files.length > room) setError(translate(getLocale(), "chat.imageLimit"));
    for (const file of files.slice(0, Math.max(0, room))) {
      const key = crypto.randomUUID();
      const url = URL.createObjectURL(file);
      setItems((prev) => [...prev, { key, url }]);
      void (async () => {
        let blob: Blob;
        try { blob = await shrink(file); } catch {
          setError(translate(getLocale(), "chat.imageDecodeFailed"));
          remove(key);
          return;
        }
        try {
          const id = await upload(blob);
          setItems((prev) => prev.map((p) => (p.key === key ? { ...p, id } : p)));
        } catch (e) {
          setError(errText(e));
          remove(key);
        }
      })();
    }
  }, [remove]);

  return {
    items, error, add, remove, clear,
    busy: items.some((p) => !p.id),
    readyIds: items.flatMap((p) => (p.id ? [p.id] : [])),
  };
}
