// Спільні motion-константи для графіків (DESIGN.md §10.4).
// Recharts анімує JS-ом, тож CSS `prefers-reduced-motion` його не глушить —
// вимикаємо draw-in вручну через цей прапорець.

export const prefersReducedMotion =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Один делікатний draw-in ліній/дуг на mount (~600ms ease-out), не 1500ms дефолт.
export const CHART_ANIM = {
  isAnimationActive: !prefersReducedMotion,
  animationDuration: 600,
  animationEasing: "ease-out" as const,
};
