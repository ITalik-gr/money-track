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

// Кожен скелет нижче навмисно повторює КЛАСИ справжнього блоку (`.runway-card`, `.sub-card`,
// `.budget-card`), а не малює абстрактний прямокутник: сітка й падінги тоді беруться з тієї
// самої CSS, тож перехід «скелет → дані» не смикає layout. Абстрактна коробка «приблизно того
// розміру» гарантовано розʼїдеться з реальною, щойно картку поправлять.

/** Порадник: картка runway (кільце + KPI-стрічка метрик). */
export function RunwaySkeleton() {
  return (
    <div className="card runway-card" aria-hidden="true">
      <Skeleton w={132} h={132} r="50%" />
      <div className="runway-metrics">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="runway-metric">
            <Skeleton w={86} h={11} style={{ marginBottom: 3 }} />
            <Skeleton w={104} h={22} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Порадник: пронумеровані картки порад (номер + заголовок + два рядки тексту). */
export function AdviceSkeleton({ n = 3 }: { n?: number }) {
  return (
    <div className="stack" aria-hidden="true">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="card advice-card">
          <Skeleton w={26} h={26} r={8} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <Skeleton w={`${44 + (i % 3) * 9}%`} h={15} />
            <Skeleton w="100%" h={12} style={{ marginTop: 10 }} />
            <Skeleton w={`${62 + (i % 2) * 14}%`} h={12} style={{ marginTop: 6 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Підписки: сітка карток (лого + назва + сума + дата списання). */
export function SubGridSkeleton({ n = 6 }: { n?: number }) {
  return (
    <div className="sub-grid" aria-hidden="true">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="sub-card">
          <div className="row" style={{ gap: 10 }}>
            <Skeleton w={34} h={34} r={10} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <Skeleton w={`${52 + (i % 3) * 13}%`} h={14} />
              <Skeleton w="42%" h={11} style={{ marginTop: 7 }} />
            </div>
          </div>
          <Skeleton w={96} h={24} />
          <Skeleton w="66%" h={11} />
        </div>
      ))}
    </div>
  );
}

/** Бюджети: конверти (назва + сума + смуга витраченого). */
export function BudgetCardsSkeleton({ n = 6 }: { n?: number }) {
  return (
    <div className="budget-cards" aria-hidden="true">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="budget-card">
          <div className="row" style={{ gap: 8 }}>
            <Skeleton w={9} h={9} r={3} />
            <Skeleton w={`${40 + (i % 3) * 15}%`} h={14} />
          </div>
          <Skeleton w={128} h={24} />
          <Skeleton w="100%" h={8} r={999} />
        </div>
      ))}
    </div>
  );
}
