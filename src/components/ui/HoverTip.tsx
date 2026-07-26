import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// §R2-ST1: миттєвий кастомний тултип для не-recharts елементів (бари днів тижня,
// будні/вихідні, бари категорій, рядки порівняння, топ-мерчанти). Обгортка має
// display:contents — не створює власного боксу, тож grid/flex усередині не ламається.
// Сам тултип рендериться в body через портал — не обрізається overflow-контейнерами.
export function HoverTip({ content, children }: { content: ReactNode; children: ReactNode }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  return (
    <span
      style={{ display: "contents" }}
      onMouseMove={(e) => setPos({ x: e.clientX, y: e.clientY })}
      onMouseLeave={() => setPos(null)}
    >
      {children}
      {pos &&
        createPortal(
          <div
            className="hover-tip"
            style={{
              left: Math.min(pos.x + 14, window.innerWidth - 220),
              top: pos.y + 16,
            }}
          >
            {content}
          </div>,
          document.body,
        )}
    </span>
  );
}
