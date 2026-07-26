import { useEffect, useState } from "react";
import { subscribe, dismiss, type ToastItem } from "../../lib/toast.ts";
import { Icon } from "./Icon.tsx";
import { useT } from "../../i18n/index.ts";

// Стек toast-ів справа зверху. Підписується на модульний store (lib/toast).
export function Toaster() {
  const tr = useT();
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => subscribe(setItems), []);
  if (!items.length) return null;
  return (
    <div className="toaster" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast toast-${t.type}`} onClick={() => dismiss(t.id)}>
          <span className="toast-ico">
            <Icon name={t.type === "success" ? "check" : t.type === "error" ? "alert" : "info"} size={16} />
          </span>
          <span className="toast-msg">{t.msg}</span>
          <button className="toast-x" aria-label={tr("common.close")} onClick={(e) => { e.stopPropagation(); dismiss(t.id); }}>×</button>
        </div>
      ))}
    </div>
  );
}
