// Єдина точка перетворення «що завгодно, що прилетіло в catch» → людський рядок.
//
// ЧОМУ ЦЕ ІСНУЄ: RTK Query відхиляє проміс НЕ помилкою, а простим обʼєктом
// `{ status, data }` (FetchBaseQueryError) або `{ name, message }` (SerializedError).
// Тому `String(e)` давало `"[object Object]"` — і користувач бачив рівно нуль інформації
// про те, що зламалось. Ніколи не роби `toast.error(String(e))`; завжди `errText(e)`.
//
// Правило: усі catch-гілки в UI показують `errText(e)`.
import { translate } from "../i18n/index.ts";
import { getLocale } from "../i18n/locale.ts";

/** Форма помилки, яку віддає наш Worker: `{ error, detail? }` (див. `app.onError`). */
interface ApiErrorBody { error?: unknown; detail?: unknown; message?: unknown }

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Дістати текст із тіла відповіді API (обʼєкт `{error}` або сирий рядок). */
function bodyText(data: unknown): string | null {
  if (typeof data === "string") {
    const s = data.trim();
    if (!s) return null;
    // Іноді помилка приходить рядком, який сам є JSON — спробуємо розпакувати.
    if (s.startsWith("{")) {
      try { return bodyText(JSON.parse(s)); } catch { /* не JSON — віддамо як є */ }
    }
    return s;
  }
  if (isObj(data)) {
    const b = data as ApiErrorBody;
    for (const v of [b.error, b.message]) {
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return null;
}

/** Людські назви для транспортних статусів RTK Query. */
function statusText(status: unknown): string {
  if (status === "FETCH_ERROR") return translate(getLocale(), "errors.noConnection");
  if (status === "TIMEOUT_ERROR") return translate(getLocale(), "errors.timeout");
  if (status === "PARSING_ERROR") return translate(getLocale(), "errors.unexpectedResponse");
  if (status === 401) return translate(getLocale(), "errors.sessionExpired");
  if (status === 503) return translate(getLocale(), "errors.serviceUnavailable");
  if (typeof status === "number") return translate(getLocale(), "errors.serverError", { status });
  return translate(getLocale(), "errors.unknown");
}

/**
 * Перетворити будь-що з catch на текст для toast/інлайн-повідомлення.
 * Порядок: тіло відповіді API → статус → Error.message → JSON → fallback.
 */
export function errText(e: unknown, fallback = translate(getLocale(), "errors.somethingWrong")): string {
  if (e == null) return fallback;
  if (typeof e === "string") return e.trim() || fallback;
  if (e instanceof Error) return e.message || fallback;

  if (isObj(e)) {
    // FetchBaseQueryError: { status, data } — найінформативніше саме `data`.
    if ("data" in e) {
      const fromBody = bodyText(e.data);
      if (fromBody) return fromBody;
    }
    // FETCH_ERROR/TIMEOUT_ERROR/PARSING_ERROR несуть ще й `error` з текстом причини.
    if ("status" in e) {
      const raw = typeof e.error === "string" ? e.error.trim() : "";
      const base = statusText(e.status);
      return raw && raw !== base ? `${base}: ${raw}` : base;
    }
    // SerializedError: { name, message, stack }.
    if (typeof e.message === "string" && e.message.trim()) return e.message.trim();

    try {
      const j = JSON.stringify(e);
      if (j && j !== "{}") return j.slice(0, 300);
    } catch { /* циклічний обʼєкт — падаємо у fallback */ }
  }
  return fallback;
}

/** HTTP-статус із помилки RTK Query, якщо він там є (для гілок «401 → на логін»). */
export function errStatus(e: unknown): number | null {
  if (isObj(e) && typeof e.status === "number") return e.status;
  return null;
}
