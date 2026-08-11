/**
 * A local passcode screen for the PWA.
 *
 * ⚠️ **READ THIS BEFORE TRUSTING IT.** This is a PRIVACY screen, not security. Everything it
 * needs lives in the same browser as the data it covers, so anyone who can open devtools can
 * remove it, and the session cookie keeps working regardless. What it actually defends against is
 * the realistic threat for a finance app on a phone: someone glancing over your shoulder, or
 * holding your unlocked device for a minute. The Settings card says exactly this — a lock that
 * implies more than it delivers is worse than none, because it changes what people are willing to
 * leave on screen.
 *
 * The code is never stored. What is stored is `SHA-256(salt + code)` plus the random salt, so a
 * glance at localStorage does not hand over the number — which matters because the same person
 * who might see the screen might also see the storage panel.
 *
 * ⚠️ The key is scoped per user (`mt-lock:<user_id>`), like every account-shaped key in this app:
 * storage is shared per browser, and a global key would show one person's lock to another (the
 * same bug that once showed a demo visitor the owner's conversations).
 * ⚠️ It deliberately SURVIVES logout, unlike the chat keys in `lib/localdata.ts` and like the
 * theme: it is a property of this device, and signing out to silently disable your own lock is
 * the opposite of what the person asked for.
 */

const PREFIX = "mt-lock";
/** Digits only, and short: this is a phone-shaped gesture, not a password. */
export const CODE_LENGTH = 4;

interface Stored { salt: string; hash: string }

const keyFor = (userId: string) => `${PREFIX}:${userId}`;

function read(userId: string): Stored | null {
  try {
    const raw = localStorage.getItem(keyFor(userId));
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<Stored>;
    return typeof p.salt === "string" && typeof p.hash === "string" ? { salt: p.salt, hash: p.hash } : null;
  } catch {
    // Corrupt entry = no lock. Failing OPEN is deliberate: being locked out of your own finances
    // by a bad JSON string is a worse outcome than the screen not appearing.
    return null;
  }
}

export const isLockSet = (userId: string): boolean => read(userId) !== null;

async function digest(salt: string, code: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${salt}:${code}`);
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function setLock(userId: string, code: string): Promise<void> {
  const salt = crypto.randomUUID();
  localStorage.setItem(keyFor(userId), JSON.stringify({ salt, hash: await digest(salt, code) }));
}

export function clearLock(userId: string): void {
  localStorage.removeItem(keyFor(userId));
  sessionStorage.removeItem(`${PREFIX}-open`);
}

export async function verifyLock(userId: string, code: string): Promise<boolean> {
  const s = read(userId);
  if (!s) return true;
  return (await digest(s.salt, code)) === s.hash;
}

/**
 * Whether the app is unlocked for THIS tab session.
 *
 * `sessionStorage`, not `localStorage`: the lock should return when the app is genuinely reopened,
 * and survive a reload in between. A flag in `localStorage` would mean unlocking once and never
 * seeing the screen again, which is the same as not having it.
 */
export const isUnlocked = (): boolean => sessionStorage.getItem(`${PREFIX}-open`) === "1";
export const markUnlocked = (): void => sessionStorage.setItem(`${PREFIX}-open`, "1");
