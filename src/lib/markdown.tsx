import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { highlightAmounts } from "./highlight.tsx";
import { numFmt } from "../i18n/locale.ts";

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
// Lazy so it reflects the CURRENT locale — a module-level Intl.NumberFormat would lock the
// grouping to whatever locale was active at first import and never follow a language switch.
const fmtNum = { format: (n: number) => numFmt({ maximumFractionDigits: 0 }).format(n) };
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

// §CTX: AI кидає таблицю директивою [table]…[/table]. Перший рядок — заголовки колонок,
// далі — рядки даних, усе через «|». Числові клітинки підсвічуються (highlightAmounts),
// перша колонка — лейбл. Self-contained, CSP-safe.
function TableBlock({ title, header, rows, keyBase }: { title: string | null; header: string[]; rows: string[][]; keyBase: string }) {
  return (
    <div className="md-table-wrap" key={keyBase}>
      {title && <div className="md-table-title">{title}</div>}
      <table className="md-table">
        <thead>
          <tr>{header.map((h, i) => <th key={`${keyBase}-h${i}`} className={i === 0 ? "md-td-lbl" : ""}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={`${keyBase}-r${ri}`}>
              {r.map((cell, ci) => (
                <td key={`${keyBase}-r${ri}c${ci}`} className={ci === 0 ? "md-td-lbl" : "md-td-num"}>
                  {ci === 0 ? cell : highlightAmounts(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
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
    // Блок-таблиця: [table] або [table:Заголовок] … [/table]. Перший рядок — заголовки.
    const tableStart = line.trim().match(/^\[table(?::\s*(.+?))?\]$/i);
    if (tableStart) {
      flushList();
      const title = tableStart[1]?.trim() || null;
      const gridRows: string[][] = [];
      idx++;
      while (idx < lines.length && !/^\s*\[\/table\]\s*$/i.test(lines[idx])) {
        const cells = lines[idx].split("|").map((c) => c.trim());
        if (cells.some((c) => c)) gridRows.push(cells);
        idx++;
      }
      if (gridRows.length >= 2) {
        const header = gridRows[0];
        const body = gridRows.slice(1).map((r) => { const c = [...r]; while (c.length < header.length) c.push(""); return c.slice(0, header.length); });
        blocks.push(<TableBlock key={`table${key++}`} keyBase={`table${key}`} title={title} header={header} rows={body} />);
      }
      continue;
    }
    // GFM pipe table: a `| … |` row followed by a `|---|---|` separator (B7).
    //
    // The custom `[table]` directive above is what the prompt asks for, but the model writes an
    // ordinary markdown table anyway — that is what it was trained on, and no amount of prompt
    // wording reliably beats that. Unparsed, it reached the user as literal `|------|------|`
    // rubble in the middle of an answer. Rendering both means the output is right whichever
    // syntax the model reaches for, instead of depending on it obeying.
    if (/^\s*\|.*\|\s*$/.test(line) && idx + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[idx + 1])) {
      flushList();
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const header = cells(line);
      idx += 2; // header + separator
      const body: string[][] = [];
      while (idx < lines.length && /^\s*\|.*\|\s*$/.test(lines[idx])) {
        const r = cells(lines[idx]);
        while (r.length < header.length) r.push("");
        body.push(r.slice(0, header.length));
        idx++;
      }
      blocks.push(<TableBlock key={`table${key++}`} keyBase={`table${key}`} title={null} header={header} rows={body} />);
      idx--; // the loop's own `idx++` must land ON the first non-table line, not past it
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
