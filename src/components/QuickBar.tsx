import { Link } from "react-router-dom";
import { useGetSafeToSpendQuery, useGetForecastQuery } from "../store/api.ts";
import { Icon } from "./Icon.tsx";
import { formatMinor } from "../lib/format.ts";

// §4 Командний рядок Головної: швидкі дії (навігація) + швидкі інсайти (детерміновані,
// без AI — миттєво з safe-to-spend/forecast). Компактно, над колонками дашборду.
const ACTIONS = [
  { to: "/add", icon: "add", label: "Додати" },
  { to: "/reports", icon: "report", label: "Репорт" },
  { to: "/advisor", icon: "advisor", label: "Порадник" },
  { to: "/plan", icon: "plan", label: "Бюджети" },
] as const;

interface Chip { text: string; tone: "pos" | "neg" | "warn" | "" }

export function QuickBar() {
  const { data: sts } = useGetSafeToSpendQuery();
  const { data: fc } = useGetForecastQuery();

  const chips: Chip[] = [];
  if (sts) {
    // Норма заощаджень місяця.
    const net = sts.income - sts.spend;
    const rate = sts.income > 0 ? Math.round((net / sts.income) * 100) : null;
    if (rate != null) chips.push({ text: `Заощадження ${rate > 0 ? "+" : ""}${rate}%`, tone: rate >= 20 ? "pos" : rate < 0 ? "neg" : "warn" });
    // Вільно до кінця місяця.
    chips.push(sts.safe >= 0
      ? { text: `Вільно ${formatMinor(sts.safe, { decimals: false })} ₴`, tone: "pos" }
      : { text: `Перевитрата ${formatMinor(Math.abs(sts.safe), { decimals: false })} ₴`, tone: "neg" });
  }
  if (fc) {
    chips.push(fc.projectedNet >= 0
      ? { text: `Прогноз місяця +${formatMinor(fc.projectedNet, { decimals: false })} ₴`, tone: "pos" }
      : { text: `Прогноз місяця −${formatMinor(Math.abs(fc.projectedNet), { decimals: false })} ₴`, tone: "neg" });
  }

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
      {chips.length > 0 && (
        <div className="qb-insights">
          {chips.slice(0, 3).map((ch, i) => (
            <span key={i} className={`qb-chip ${ch.tone}`}>{ch.text}</span>
          ))}
        </div>
      )}
    </div>
  );
}
