import type { AiUsageBrief } from "../store/api.ts";

// Приблизна вартість виклику (Haiku 4.5: $1/$5 за млн вх/вих, кеш-читання $0.10/млн).
function cost(u: AiUsageBrief): number {
  return (u.in * 1 + u.cache_read * 0.1 + u.out * 5) / 1_000_000;
}
function toks(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function UsageCost({ usage }: { usage?: AiUsageBrief }) {
  if (!usage) return null;
  const c = cost(usage);
  const total = usage.in + usage.out + usage.cache_read;
  return (
    <span className="usage-cost" title={`вх ${usage.in} · вих ${usage.out} · кеш ${usage.cache_read}`}>
      ≈ ${c < 0.001 ? c.toFixed(5) : c.toFixed(4)} · {toks(total)} ток{usage.cache_read > 0 ? " · кеш ✓" : ""}
    </span>
  );
}
