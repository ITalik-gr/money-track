// Глобальні toast-повідомлення (міні-попапи справа зверху). Модульний pub/sub, щоб
// будь-який файл кликав `toast.success(...)` без прокидання контексту. <Toaster/> у Layout
// підписується й рендерить стек.
export type ToastType = "success" | "error" | "info";
export interface ToastItem { id: number; type: ToastType; msg: string }

type Listener = (items: ToastItem[]) => void;

let items: ToastItem[] = [];
let seq = 0;
const listeners = new Set<Listener>();

function emit() { for (const l of listeners) l(items); }

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  l(items);
  return () => { listeners.delete(l); };
}

export function dismiss(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

function push(type: ToastType, msg: string) {
  const id = ++seq;
  items = [...items, { id, type, msg }];
  emit();
  // Авто-зникнення (помилки тримаємо трохи довше).
  setTimeout(() => dismiss(id), type === "error" ? 6000 : 4000);
  return id;
}

export const toast = {
  success: (msg: string) => push("success", msg),
  error: (msg: string) => push("error", msg),
  info: (msg: string) => push("info", msg),
};
