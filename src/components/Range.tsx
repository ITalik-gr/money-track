import type { CSSProperties } from "react";

// Переюзабельний повзунок (`.rng`) — заміна нативному `input[type=range]`, як `Select`
// замість native `<select>` (§Інваріанти). Нативний віджет тягне OS-вигляд (товстий трек +
// великий сатурований кружок), який не тримає ані шкалу радіусів, ані палітру системи.
// Заливку рахуємо тут і віддаємо в CSS через `--rng-p`: `::-moz-range-progress` є лише у
// Firefox, тож у WebKit трек малюється градієнтом із тією ж точкою зупинки.
interface Props {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Точка, ВІД якої малюється заливка. Дефолт — `min` (звична шкала зліва направо).
   *  Для двобічної шкали (−100…+100) став `0` — заливка піде від центра в бік значення. */
  origin?: number;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
}

export function Range({ value, onChange, min = 0, max = 100, step = 1, origin, ariaLabel, disabled, className }: Props) {
  const span = max - min;
  const pctOf = (v: number) => (span > 0 ? ((Math.min(Math.max(v, min), max) - min) / span) * 100 : 0);
  return (
    <input
      type="range"
      className={`rng${className ? ` ${className}` : ""}`}
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      style={{ "--rng-p": `${pctOf(value)}%`, "--rng-o": `${pctOf(origin ?? min)}%` } as CSSProperties}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}
