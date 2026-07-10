import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { highlightAmounts } from "./highlight.tsx";

// Легкий рендер markdown-відповідей AI (без зовнішніх бібліотек, CSP-safe):
// **жирний**, списки (-, •, —, «1.»), заголовки (###), абзаци, чипи-транзакції
// [tx:ID|Підпис] → клікабельний чип на /tx/ID. Суми/% підсвічуються.

// **жирний** + підсвітка сум усередині простого тексту.
function boldAndAmounts(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0, i = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(...highlightAmounts(text.slice(last, m.index)));
    out.push(<strong key={`${keyBase}-b${i++}`}>{highlightAmounts(m[1])}</strong>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(...highlightAmounts(text.slice(last)));
  return out;
}

// Інлайн: спершу виймаємо чипи-транзакції, решту віддаємо в boldAndAmounts.
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\[tx:([^|\]]+)\|([^\]]+)\]/g;
  let last = 0, i = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(...boldAndAmounts(text.slice(last, m.index), `${keyBase}-s${i}`));
    out.push(<Link key={`${keyBase}-tx${i++}`} to={`/tx/${m[1]}`} className="tx-chip">{m[2].trim()}</Link>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(...boldAndAmounts(text.slice(last), `${keyBase}-e`));
  return out;
}

const BULLET = /^\s*(?:[-•—*]|\d+[.)])\s+(.*)$/;

// §CH4: AI кидає графік у чат директивою [chart]…[/chart], кожен рядок «Підпис|значення».
// Рендеримо горизонтальні бари (self-contained, CSP-safe, без сторонніх ліб).
const fmtNum = new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 0 });
function ChartBlock({ title, rows, keyBase }: { title: string | null; rows: { label: string; value: number }[]; keyBase: string }) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <div className="md-chart" key={keyBase}>
      {title && <div className="md-chart-title">{title}</div>}
      {rows.map((r, i) => (
        <div className="md-chart-row" key={`${keyBase}-r${i}`}>
          <span className="md-chart-lbl">{r.label}</span>
          <span className="md-chart-track"><span className="md-chart-fill" style={{ width: `${(r.value / max) * 100}%` }} /></span>
          <span className="md-chart-val">{fmtNum.format(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

export function renderMarkdown(text: string): ReactNode {
  const lines = text.replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = [];
  let list: ReactNode[] = [];
  let key = 0;

  const flushList = () => {
    if (list.length) { blocks.push(<ul className="md-list" key={`ul${key++}`}>{list}</ul>); list = []; }
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx].trimEnd();
    // Блок-графік: [chart] або [chart:Заголовок] … [/chart].
    const chartStart = line.trim().match(/^\[chart(?::\s*(.+?))?\]$/i);
    if (chartStart) {
      flushList();
      const title = chartStart[1]?.trim() || null;
      const rows: { label: string; value: number }[] = [];
      idx++;
      while (idx < lines.length && !/^\s*\[\/chart\]\s*$/i.test(lines[idx])) {
        const parts = lines[idx].split("|");
        if (parts.length >= 2) {
          const value = Number(parts[1].replace(/[^\d.-]/g, ""));
          if (parts[0].trim() && !Number.isNaN(value)) rows.push({ label: parts[0].trim(), value });
        }
        idx++;
      }
      if (rows.length) blocks.push(<ChartBlock key={`chart${key++}`} keyBase={`chart${key}`} title={title} rows={rows} />);
      continue;
    }
    if (!line.trim()) { flushList(); continue; }
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    if (heading) { flushList(); blocks.push(<div className="md-h" key={`h${key++}`}>{inline(heading[1], `h${key}`)}</div>); continue; }
    const bullet = line.match(BULLET);
    if (bullet) { list.push(<li key={`li${key++}`}>{inline(bullet[1], `li${key}`)}</li>); continue; }
    flushList();
    blocks.push(<p className="md-p" key={`p${key++}`}>{inline(line, `p${key}`)}</p>);
  }
  flushList();
  return <>{blocks}</>;
}
