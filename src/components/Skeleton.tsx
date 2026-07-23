import type { CSSProperties } from "react";

// Плейсхолдер-шимер на час фетчу (замість «завантаження…»-тексту). Форма елемента натякає
// на майбутній контент — тож перехід «скелет → дані» не смикає layout. CSS — .skeleton.
export function Skeleton({ w, h = 14, r, className = "", style }: {
  w?: number | string; h?: number | string; r?: number | string; className?: string; style?: CSSProperties;
}) {
  return <span className={`skeleton ${className}`} style={{ width: w, height: h, borderRadius: r, ...style }} aria-hidden="true" />;
}

// Кілька рядків «назва … сума» — для лінивих панелей дрилу (CatDrill/SliceDrill), де раніше
// висів голий текст «Завантаження…».
export function SkeletonRows({ n = 4 }: { n?: number }) {
  return (
    <div className="sk-rows" aria-hidden="true">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="sk-row">
          <Skeleton w={`${45 + (i % 3) * 12}%`} h={12} />
          <Skeleton w={54} h={12} />
        </div>
      ))}
    </div>
  );
}

// Скелет вкладки «Огляд» Статистики: KPI-плитки + смуга фактів + блок графіка.
// Повторює справжню сітку (.stat-kpis / .stat-facts / .card cashflow), щоб не було стрибка.
export function StatsSkeleton() {
  return (
    <div className="stack" style={{ gap: 18 }} aria-hidden="true">
      <div className="stat-kpis">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="card kpi-tile">
            <Skeleton w={92} h={12} />
            <Skeleton w={128} h={30} style={{ marginTop: 14 }} />
            <Skeleton w={70} h={12} style={{ marginTop: 14 }} />
          </div>
        ))}
      </div>
      <div className="stat-facts">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="fact">
            <Skeleton w={80} h={11} />
            <Skeleton w={110} h={18} style={{ marginTop: 10 }} />
          </div>
        ))}
      </div>
      <div className="card" style={{ height: 288 }}>
        <Skeleton w="38%" h={14} />
        <Skeleton w="100%" h={222} style={{ marginTop: 18 }} />
      </div>
    </div>
  );
}
