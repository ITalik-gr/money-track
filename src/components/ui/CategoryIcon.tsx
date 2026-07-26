// Лінійні іконки категорій (currentColor). Слаг зберігається в categories.icon.
// Невідомий слаг → крапка. Стиль узгоджений з Icon.tsx (stroke 1.7, round).
const P: Record<string, React.ReactNode> = {
  cart: (<><circle cx="9" cy="20" r="1.3" /><circle cx="17" cy="20" r="1.3" /><path d="M2 3h2l2.3 12.2a1.5 1.5 0 0 0 1.5 1.2h8.5a1.5 1.5 0 0 0 1.5-1.2L21 7H5.2" /></>),
  coffee: (<><path d="M5 9h11v4a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5z" /><path d="M16 10h2.5a2.5 2.5 0 0 1 0 5H16" /><path d="M7 3v2M11 3v2" /></>),
  car: (<><path d="M4 11l1.6-4.2A2 2 0 0 1 7.5 5.5h9a2 2 0 0 1 1.9 1.3L20 11" /><path d="M3 11h18v5H3z" /><circle cx="7" cy="16.5" r="1.3" /><circle cx="17" cy="16.5" r="1.3" /></>),
  health: (<><rect x="4" y="4" width="16" height="16" rx="4.5" /><path d="M12 8.5v7M8.5 12h7" /></>),
  shirt: (<path d="M9 3.5L4 6.5l2 3 2-1v10h8V8.5l2 1 2-3-5-3a3 3 0 0 1-6 0z" />),
  ticket: (<><path d="M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2 2 2 0 0 0 0 4 2 2 0 0 1-2 2H5a2 2 0 0 1-2-2 2 2 0 0 0 0-4z" /><path d="M15 6.5v2M15 15.5v2" /></>),
  bolt: (<path d="M13 2L4 14h6l-1 8 9-12h-6z" />),
  home: (<><path d="M4 11l8-7 8 7" /><path d="M6 10v9h12v-9" /></>),
  chip: (<><rect x="7" y="7" width="10" height="10" rx="1.5" /><path d="M10 3v2M14 3v2M10 19v2M14 19v2M3 10h2M3 14h2M19 10h2M19 14h2" /></>),
  sparkle: (<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />),
  plane: (<path d="M21 3L3 11l7 2 2 7 3-6z" />),
  repeat: (<><path d="M17 2l4 4-4 4" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><path d="M7 22l-4-4 4-4" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></>),
  swap: (<><path d="M7 4v13M7 4L3.5 7.5M7 4l3.5 3.5" /><path d="M17 20V7M17 20l-3.5-3.5M17 20l3.5-3.5" /></>),
  dots: (<><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></>),
  wallet: (<><rect x="3" y="6" width="18" height="13" rx="2.5" /><path d="M3 10.5h18" /><circle cx="16.5" cy="14" r="1.1" /></>),
  laptop: (<><rect x="4" y="5" width="16" height="11" rx="1.5" /><path d="M2 20h20" /></>),
  undo: (<><path d="M8 8l-4 4 4 4" /><path d="M4 12h11a4.5 4.5 0 0 1 0 9h-2" /></>),
  plus: (<><circle cx="12" cy="12" r="9" /><path d="M12 8v8M8 12h8" /></>),
  book: (<><path d="M5 4.5h11a2 2 0 0 1 2 2V20H7a2 2 0 0 1-2-2z" /><path d="M18 16.5H7a2 2 0 0 0-2 2" /></>),
  baby: (<><path d="M9 8h6v9a3 3 0 0 1-3 3 3 3 0 0 1-3-3z" /><path d="M9.5 8L9 6h6l-.5 2" /><path d="M11 4h2" /><path d="M10 12h4M10 15h4" /></>),
  paw: (<><circle cx="7" cy="9" r="1.5" /><circle cx="12" cy="7" r="1.5" /><circle cx="17" cy="9" r="1.5" /><path d="M12 12c-2.4 0-4.3 1.9-4.3 4C7.7 17.8 9.2 19 12 19s4.3-1.2 4.3-3C16.3 13.9 14.4 12 12 12z" /></>),
  dumbbell: (<path d="M3 9v6M6 7v10M18 7v10M21 9v6M6 12h12" />),
  gift: (<><rect x="3.5" y="8" width="17" height="4" rx="1" /><path d="M5 12v8h14v-8" /><path d="M12 8v12" /><path d="M12 8S10.5 4 8.5 4a2 2 0 0 0 0 4zM12 8s1.5-4 3.5-4a2 2 0 0 1 0 4z" /></>),
  tax: (<><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" /><path d="M9.5 9l5 5" /><circle cx="9.7" cy="9.2" r="0.9" /><circle cx="14.3" cy="13.8" r="0.9" /></>),
  fuel: (<><path d="M4 20V5a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v15" /><path d="M3 20h11" /><path d="M7 9h3" /><path d="M13 7l3 3v6.5a1.8 1.8 0 0 0 3 0V9l-3-3" /></>),
  tag: (<><path d="M3 12.5V4.5a1 1 0 0 1 1-1h8l9 9-9 9z" /><circle cx="7.5" cy="8" r="1.2" /></>),
  coins: (<><circle cx="8" cy="12" r="5" /><path d="M13 7.4A5 5 0 1 1 13 16.6" /></>),
  gamepad: (<><rect x="3" y="8" width="18" height="9" rx="4.5" /><path d="M6.5 11v3M5 12.5h3" /><circle cx="15.5" cy="11.8" r="0.9" /><circle cx="17.6" cy="13.8" r="0.9" /></>),
  bus: (<><rect x="4" y="5" width="16" height="12" rx="2.2" /><path d="M4 11.5h16M7 17v2M17 17v2" /><circle cx="8" cy="14" r="0.7" /><circle cx="16" cy="14" r="0.7" /></>),
  pill: (<><rect x="3.5" y="9" width="17" height="6" rx="3" /><path d="M12 9v6" /></>),
};

// Усі доступні слаги іконок — для пікера в редакторі категорій.
export const ICON_SLUGS = Object.keys(P);

export function CategoryIcon({ slug, size = 18 }: { slug: string | null | undefined; size?: number }) {
  const node = slug ? P[slug] : null;
  if (!node) return <span style={{ width: 7, height: 7, borderRadius: "50%", background: "currentColor", display: "inline-block" }} />;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {node}
    </svg>
  );
}
