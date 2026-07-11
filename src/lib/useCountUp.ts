import { useEffect, useRef, useState } from "react";

// Делікатний count-up для герой-чисел (DESIGN.md §10.4): анімуємо 0→значення
// один раз, коли дані приходять, і плавно переходимо при зміні (напр. перемикач
// періоду). Під `prefers-reduced-motion` — миттєво. Крива — ease-out (без bounce).
// tabular-nums на числі не дає верстці «стрибати» покадрово.

const prefersReduced = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ease-out-quart — швидкий старт, м'яке осідання
const easeOutQuart = (t: number) => 1 - Math.pow(1 - t, 4);

export function useCountUp(target: number, duration = 500): number {
  const [val, setVal] = useState(target);
  const prevRef = useRef(0);

  useEffect(() => {
    if (!Number.isFinite(target)) return;
    if (prefersReduced()) {
      prevRef.current = target;
      setVal(target);
      return;
    }
    const from = prevRef.current;
    if (from === target) {
      setVal(target);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / duration);
      setVal(from + (target - from) * easeOutQuart(p));
      if (p < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        prevRef.current = target;
        setVal(target);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);

  return val;
}
