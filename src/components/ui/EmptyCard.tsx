import { Link } from "react-router-dom";
import { Icon } from "./Icon.tsx";

// Placeholder for a block that has nothing to show YET (not an error, not a loading state).
//
// WHY IT EXISTS: several blocks used to `return null` when their data was empty. Inside a
// two-column grid that leaves one half of the page blank, which reads as broken layout — the
// exact complaint from the first live run (ROADMAP L3, and before that the `.advisor-grid.single`
// bug in DESIGN.md §Журнал 2026-07-14). A block that says what WILL be here, and how to get it,
// is both honest and useful; `null` is neither.
//
// Deliberately distinct from `<ErrorNote>` (--neg + cause + retry): empty is neutral, an error
// is not. Rule from DESIGN.md §Журнал 2026-07-20 — emptiness and failure must not look alike.
export function EmptyCard({ icon = "spark", title, hint, to, action }: {
  icon?: string;
  title: string;
  hint: string;
  /** Where the user goes to make this block fill up. Rendered only together with `action`. */
  to?: string;
  action?: string;
}) {
  return (
    <div className="card empty-card">
      <span className="ec-ico"><Icon name={icon} size={18} /></span>
      <div className="ec-title">{title}</div>
      <p className="ec-hint">{hint}</p>
      {to && action ? <Link to={to} className="btn sm">{action}</Link> : null}
    </div>
  );
}
