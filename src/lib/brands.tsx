// Локальні бренд-стилі мерчантів — БЕЗ зовнішніх запитів (приватність).
// matchBrand(name) → бренд-колір плитки + опційний простий гліф (узагальнений,
// не точна копія торгової марки). Решта показується монограмою в бренд-кольорі.
// Fallback за межами цього списку — іконка категорії (у MerchantLogo).

export interface Brand { color: string; mark?: string; fg?: string }

// Прості узагальнені гліфи (біла заливка на кольоровій плитці). Тип-натяк, не логотип.
export const BRAND_MARKS: Record<string, React.ReactNode> = {
  play: <path d="M9 7.5v9l7.5-4.5z" fill="currentColor" />,                       // відео-сервіси
  music: (
    <>
      <circle cx="12" cy="12" r="8.4" fill="none" stroke="currentColor" strokeWidth="1.7" opacity="0.35" />
      <path d="M7.5 9.5c3-1 6-.7 8.6.8M8 12.4c2.4-.8 4.8-.5 6.9.7M8.6 15.1c1.8-.6 3.5-.4 5 .5"
        fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </>
  ),
  bolt: <path d="M13 3L5 13h5l-1 8 9-11h-6z" fill="currentColor" />,               // Bolt / райд
  bag: (
    <>
      <path d="M6 8h12l-1 11H7z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M9 8a3 3 0 0 1 6 0" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </>
  ),
  arch: <path d="M4 18V12a8 8 0 0 1 16 0v6M12 18V11" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />, // фастфуд
  parcel: (
    <>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M4 7.5l8 4.5 8-4.5M12 12v9" fill="none" stroke="currentColor" strokeWidth="1.7" />
    </>
  ),
  spark: <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" fill="currentColor" />, // AI
};

// Порядок важливий (перший збіг виграє). color — фірмовий колір плитки.
const BRANDS: [RegExp, Brand][] = [
  [/атб|\batb\b/i, { color: "#E30613" }],
  [/сільпо|silpo/i, { color: "#E4002B" }],
  [/фора|\bfora\b/i, { color: "#7AB800" }],
  [/новус|novus/i, { color: "#C8102E" }],
  [/варус|varus/i, { color: "#F39200", fg: "#1a1a1a" }],
  [/rozetka|розетка/i, { color: "#00A046" }],
  [/епіцентр|epicentr/i, { color: "#FFDD00", fg: "#1a1a1a" }],
  [/glovo|bolt.?food|raketa/i, { color: "#FFC244", fg: "#1a1a1a", mark: "bag" }],
  [/blablacar/i, { color: "#1FBAD6" }],
  [/uklon|уклон/i, { color: "#111827" }],
  [/\bbolt\b/i, { color: "#34D186", fg: "#0a1a12", mark: "bolt" }],
  [/\buber\b/i, { color: "#111111" }],
  [/нова.?пошта|nova.?posh/i, { color: "#DA291C", mark: "parcel" }],
  [/укрпошта|ukrposhta/i, { color: "#FFD200", fg: "#1a1a1a", mark: "parcel" }],
  [/mcdonald|макдональд/i, { color: "#DA291C", mark: "arch" }],
  [/\bkfc\b/i, { color: "#A6192E", mark: "arch" }],
  [/netflix/i, { color: "#E50914", mark: "play" }],
  [/youtube/i, { color: "#FF0000", mark: "play" }],
  [/megogo|sweet.?tv|київстар.?тб/i, { color: "#7A3E9D", mark: "play" }],
  [/spotify/i, { color: "#1DB954", mark: "music" }],
  [/apple.?music|deezer/i, { color: "#111111", mark: "music" }],
  [/google/i, { color: "#4285F4" }],
  [/apple|app store|itunes/i, { color: "#111111" }],
  [/anthropic|claude/i, { color: "#D97757", mark: "spark" }],
  [/openai|chatgpt/i, { color: "#0f0f0f", mark: "spark" }],
  [/\bsteam\b/i, { color: "#1B2838" }],
  [/monobank|моно/i, { color: "#000000" }],
  [/приват|privat/i, { color: "#4CAF50" }],
  [/\bwog\b/i, { color: "#E30613", mark: "bolt" }],
  [/okko|окко/i, { color: "#FF6A13", mark: "bolt" }],
];

export function matchBrand(name: string | null): Brand | null {
  if (!name) return null;
  for (const [re, b] of BRANDS) if (re.test(name)) return b;
  return null;
}
