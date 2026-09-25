import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// §R2-ST1: миттєвий кастомний тултип для не-recharts елементів (бари днів тижня,
// будні/вихідні, бари категорій, рядки порівняння, топ-мерчанти). Обгортка має
// display:contents — не створює власного боксу, тож grid/flex усередині не ламається.
// Сам тултип рендериться в body через портал — не обрізається overflow-контейнерами.
//
// `content` may be null: a chart that knows WHICH part is under the cursor (a sparkline point, a
// column) passes null between parts, and the tip hides instead of showing a stale one.
// Near the right or bottom edge the tip flips to the other side of the cursor — clamping alone
// covered the cursor with the tip it had just opened.
const TIP_W = 250;
const TIP_H = 170;

export function HoverTip({ content, children }: { content: ReactNode; children: ReactNode }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const flipX = pos != null && pos.x + 14 + TIP_W > window.innerWidth;
  const flipY = pos != null && pos.y + 16 + TIP_H > window.innerHeight;
  return (
    <span
      style={{ display: "contents" }}
      onMouseMove={(e) => setPos({ x: e.clientX, y: e.clientY })}
      onMouseLeave={() => setPos(null)}
    >
      {children}
      {pos && content != null && content !== false &&
        createPortal(
          <div
            className="hover-tip"
            style={{
              left: flipX ? Math.max(8, pos.x - 14) : pos.x + 14,
              top: flipY ? pos.y - 12 : pos.y + 16,
              transform: `translate(${flipX ? "-100%" : "0"}, ${flipY ? "-100%" : "0"})`,
            }}
          >
            {content}
          </div>,
          document.body,
        )}
    </span>
  );
}

/**
 * The common body of a bar/segment tip: what it is (with its colour), how much, and one line of
 * context (a share, «of what»). One shape so every chart in the app answers a hover the same way —
 * the owner found half of them answered nothing at all and the rest in a native `title` that took a
 * second to appear.
 */
export function TipBody({ label, value, sub, color }: { label: ReactNode; value: ReactNode; sub?: ReactNode; color?: string | null }) {
  return (
    <>
      <div className="tip-lbl r">{color && <span className="d" style={{ background: color }} />}{label}</div>
      <div className="tip-big">{value}</div>
      {sub != null && sub !== false && <div className="tip-muted">{sub}</div>}
    </>
  );
}
