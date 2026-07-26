import { Link } from "react-router-dom";
import { Icon } from "./Icon.tsx";
import { useT } from "../i18n/index.ts";
import type { TranslationKey } from "../i18n/index.ts";

// Головна: компактний рядок швидких переходів на розділи, яких немає в нижній
// таб-навігації мобілки. «Додати» живе в hero-картці балансу (не дублюємо тут);
// метрики-чипи прибрано — їх повноцінно показують картки SafeToSpend/Pulse/Forecast.
const ACTIONS: { to: string; icon: string; label: TranslationKey }[] = [
  { to: "/reports", icon: "report", label: "qb.report" },
  { to: "/advisor", icon: "advisor", label: "nav.advisor" },
  { to: "/plan", icon: "plan", label: "nav.plan" },
];

export function QuickBar() {
  const t = useT();
  return (
    <div className="quickbar">
      <div className="qb-actions">
        {ACTIONS.map((a) => (
          <Link key={a.to} to={a.to} className="qb-action">
            <Icon name={a.icon} size={17} />
            <span>{t(a.label)}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
