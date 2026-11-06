import type { AiUsageBrief } from "../../store/api.ts";
import { useT } from "../../i18n/index.ts";

// Приблизна вартість виклику (Haiku 5.5: $0.10/$0.50 за млн вх/вих до 100K промпту, кеш-читання $0.01/млн).
function cost(u: AiUsageBrief): number {
  return (u.in * 0.1 + u.cache_read * 0.01 + u.out * 0.5) / 1_000_000;
}
function toks(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function UsageCost({ usage }: { usage?: AiUsageBrief }) {
  const t = useT();
  if (!usage) return null;
  const c = cost(usage);
  const total = usage.in + usage.out + usage.cache_read;
  return (
    <span className="usage-cost" title={t("uc.titleTip", { in: usage.in, out: usage.out, cache: usage.cache_read })}>
      ≈ ${c < 0.001 ? c.toFixed(5) : c.toFixed(4)} · {toks(total)} {t("uc.tokAbbr")}{usage.cache_read > 0 ? t("uc.cacheCheckSuffix") : ""}
    </span>
  );
}
