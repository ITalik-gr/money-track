import { Link } from "react-router-dom";
import { Icon } from "./Icon.tsx";

// Головна: компактний рядок швидких переходів на розділи, яких немає в нижній
// таб-навігації мобілки. «Додати» живе в hero-картці балансу (не дублюємо тут);
// метрики-чипи прибрано — їх повноцінно показують картки SafeToSpend/Pulse/Forecast.
const ACTIONS = [
  { to: "/reports", icon: "report", label: "Репорт" },
  { to: "/advisor", icon: "advisor", label: "Порадник" },
  { to: "/plan", icon: "plan", label: "Бюджети" },
] as const;

export function QuickBar() {
  return (
    <div className="quickbar">
      <div className="qb-actions">
        {ACTIONS.map((a) => (
          <Link key={a.to} to={a.to} className="qb-action">
            <Icon name={a.icon} size={17} />
            <span>{a.label}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
