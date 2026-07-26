// Shared cartesian-axis defaults (B4).
//
// Why this exists. Every chart used to hardcode `width={46}` (networth: 54, advisor: 40) on its
// Y axis and then claw the space back with a negative left margin (`left: -14`). Those numbers
// were tuned against the values that happened to be on screen at the time — so as soon as the
// scale grew a digit, the label ran out of its box and was CLIPPED: the networth chart showed
// "00,000" where it meant "500,000", and a reader has no way to tell a clipped axis from a real
// number. An axis that silently lies about its scale is worse than no axis.
//
// Recharts 3.9 measures the rendered ticks itself when `width="auto"`, so the axis is exactly as
// wide as its widest label — at any locale, currency scale or column width. The negative left
// margins go with it: they only existed to compensate for the fixed box.
//
// Spread this into `<YAxis {...Y_AXIS} tickCount={…} tickFormatter={…} />`. Keep `tickCount` and
// the formatter per-chart — those are about the data, not the geometry.
export const Y_AXIS = {
  tickLine: false,
  axisLine: false,
  width: "auto",
  tick: { fontSize: 11, fill: "var(--muted)" },
} as const;

/**
 * Left margin for a chart that has a Y axis. Zero, and named rather than inlined: a bare `0`
 * invites the next person to "just nudge it" back to a negative value and re-break the clipping.
 */
export const Y_AXIS_LEFT_MARGIN = 0;
