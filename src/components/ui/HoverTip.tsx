import { cloneElement, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";

// §R2-ST1: миттєвий кастомний тултип для не-recharts елементів (бари днів тижня,
// будні/вихідні, бари категорій, рядки порівняння, топ-мерчанти). Обгортка має
// display:contents — не створює власного боксу, тож grid/flex усередині не ламається.
// Сам тултип рендериться в body через портал — не обрізається overflow-контейнерами.
//
// `content` may be null: a chart that knows WHICH part is under the cursor (a sparkline point, a
// column) passes null between parts, and the tip hides instead of showing a stale one.
// Near the right or bottom edge the tip flips to the other side of the cursor — clamping alone
// covered the cursor with the tip it had just opened. The flip is decided from the MEASURED tip
// (T3), and a flipped tip is anchored by `right`/`bottom`, never `left` + `translate(-100%)`: a
// fixed box placed at `left: x` near the edge may only be as wide as the space to its right, so
// prose wrapped one word per line and the width jumped with the side it opened on.
//
// THREE WAYS IN (UI_PASS F5/F6), because a tip only a mouse can open does not exist on a phone and
// does not exist for a keyboard or a screen reader:
//   mouse — follows the pointer, as before;
//   touch — a tap opens it at the finger; a tap elsewhere or any scroll closes it;
//   focus — opens under the focused element. A child that cannot take focus on its own (a bar, a
//           segment) is given `tabIndex=0`, and while open the tip is its `aria-describedby`.
/** Until the tip has been measured once (its first frame). */
const TIP_W = 250;
const TIP_H = 170;

type Src = "mouse" | "touch" | "focus";

/** Native controls already take focus; anything else wrapped here needs a tab stop to be reachable. */
function focusable(el: ReactElement<Record<string, unknown>>): boolean {
  const p = el.props;
  return typeof el.type === "string" && ["a", "button", "input", "select", "textarea"].includes(el.type)
    || p.tabIndex != null || p.href != null || p.to != null;
}

export function HoverTip({ content, children }: { content: ReactNode; children: ReactNode }) {
  const [pos, setPos] = useState<{ x: number; y: number; src: Src } | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const id = useId();
  const open = pos != null && content != null && content !== false;

  // A touch-opened tip has no «pointer left» to close it: an outside tap or a scroll does.
  useEffect(() => {
    if (pos?.src !== "touch") return;
    const outside = (e: Event) => { if (!(e.target instanceof Node && wrap.current?.contains(e.target))) setPos(null); };
    const close = () => setPos(null);
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", close, true);
    };
  }, [pos?.src]);

  // Measured before paint; only a changed size re-renders, so following the cursor stays one render.
  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    if (!size || size.w !== w || size.h !== h) setSize({ w, h });
  });
  const tw = size?.w ?? TIP_W, th = size?.h ?? TIP_H;
  const flipX = pos != null && pos.x + 14 + tw > window.innerWidth && pos.x - 14 - tw >= 0;
  const flipY = pos != null && pos.y + 16 + th > window.innerHeight && pos.y - 12 - th >= 0;

  // Only a plain DOM element can carry the attributes: a Fragment rejects them, and a component
  // may not forward them anywhere.
  let child = children;
  if (isValidElement<Record<string, unknown>>(children) && typeof children.type === "string") {
    const extra: Record<string, unknown> = { "aria-describedby": open ? id : undefined };
    if (!focusable(children)) extra.tabIndex = 0;
    child = cloneElement(children, extra);
  }

  return (
    <span
      ref={wrap}
      style={{ display: "contents" }}
      onPointerMove={(e) => { if (e.pointerType === "mouse") setPos({ x: e.clientX, y: e.clientY, src: "mouse" }); }}
      onPointerLeave={(e) => { if (e.pointerType === "mouse") setPos(null); }}
      onPointerDown={(e) => { if (e.pointerType !== "mouse") setPos({ x: e.clientX, y: e.clientY, src: "touch" }); }}
      onFocus={(e) => {
        // Keyboard focus only: a tap focuses too, and would move a touch tip to the element's edge.
        if (pos?.src === "touch" || !e.target.matches(":focus-visible")) return;
        const r = e.target.getBoundingClientRect();
        setPos({ x: r.left + Math.min(r.width / 2, 40), y: r.bottom, src: "focus" });
      }}
      onBlur={() => { if (pos?.src === "focus") setPos(null); }}
    >
      {child}
      {open &&
        createPortal(
          <div
            ref={tipRef}
            id={id}
            role="tooltip"
            className="hover-tip"
            style={{
              ...(flipX ? { right: window.innerWidth - pos.x + 14 } : { left: Math.min(pos.x + 14, Math.max(8, window.innerWidth - tw - 8)) }),
              ...(flipY ? { bottom: window.innerHeight - pos.y + 12 } : { top: pos.y + 16 }),
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
