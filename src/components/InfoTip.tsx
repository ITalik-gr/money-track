import type { ReactNode } from "react";
import { HoverTip } from "./HoverTip.tsx";
import { Icon } from "./Icon.tsx";

// Малий інфо-індикатор для карток/KPI: ховер (і фокус — клавіатура/тач) показує
// пояснення метрики. Використовується поруч із заголовком плитки (верхній правий кут).
export function InfoTip({ children }: { children: ReactNode }) {
  return (
    <HoverTip content={<div className="tip-explain">{children}</div>}>
      {/* stopPropagation — часто сидить усередині клікабельної плитки (KPI), сам не має діяти. */}
      <span className="info-tip" tabIndex={0} role="note" aria-label="пояснення"
        onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
        <Icon name="info" size={14} />
      </span>
    </HoverTip>
  );
}
