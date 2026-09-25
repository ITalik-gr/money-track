// Глобальний перехоплювач помилок RTK Query.
//
// ЧОМУ: сторінки (Статистика в першу чергу) рендерили `data?.x ?? []` без жодної гілки
// `isError` — тож коли ендпоінт падав у 500, користувач бачив просто ПОРОЖНЮ сторінку
// й нуль підказок, що саме зламалось. Тепер будь-який відхилений запит показує toast
// із реальним текстом помилки. Це страхувальна сітка: інлайн-стани помилок на сторінках
// вона не скасовує, але гарантує, що мовчазної порожнечі більше не буде.
import { isRejectedWithValue, type Middleware } from "@reduxjs/toolkit";
import { toast } from "../lib/toast.ts";
import { errText, errStatus } from "../lib/errors.ts";

// Дедуп: один і той самий ендпоінт не спамить стек тостів (Статистика робить ~15
// паралельних запитів — усі впали б разом і завалили екран).
const recent = new Map<string, number>();
const DEDUP_MS = 8000;

export const apiErrorMiddleware: Middleware = () => (next) => (action) => {
  if (isRejectedWithValue(action)) {
    const meta = action.meta as { arg?: { endpointName?: string }; condition?: boolean } | undefined;
    const endpoint = meta?.arg?.endpointName ?? "api";
    const status = errStatus(action.payload);

    // 401 не показуємо: App і так перекидає на екран входу — toast був би шумом.
    if (status !== 401) {
      const now = Date.now();
      const last = recent.get(endpoint) ?? 0;
      if (now - last > DEDUP_MS) {
        recent.set(endpoint, now);
        // No endpoint name in front of the text (2026-09-25, before opening the app to friends):
        // «generateAdvice: …» read as a crash to anyone but the developer. The name still goes
        // to the console, where the developer looks. A missing AI key is not a failure at all —
        // it is a step, so its toast links straight to where the key goes.
        console.warn(`[api] ${endpoint}`, action.payload);
        const code = (action.payload as { data?: { code?: string } } | undefined)?.data?.code;
        toast.error(errText(action.payload), code === "no_ai_key" ? "/setup?tab=ai" : undefined);
      }
    }
  }
  return next(action);
};
