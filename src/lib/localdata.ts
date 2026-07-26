// Device-side leftovers of a signed-in account.
//
// The chat pages keep whole conversations in `localStorage` (`mt-chats:<user_id>`) — and those
// conversations are about salaries, debts and balances. Logging out cleared the cookie and left
// every word of that on the disk, readable by anyone who opens devtools on that machine
// afterwards. Signing out has to mean the device forgets too (security review 2026-07-26).
//
// Deliberately NOT clearing `mt-theme`: it is a display preference with no account in it, and
// wiping it makes the next visit flash the wrong theme for no privacy gain.
const ACCOUNT_KEY_PREFIXES = ["mt-chats", "mt-chat"];

export function clearLocalUserData(): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && ACCOUNT_KEY_PREFIXES.some((p) => key === p || key.startsWith(`${p}:`))) doomed.push(key);
    }
    for (const key of doomed) localStorage.removeItem(key);
  } catch {
    /* private mode / storage disabled — nothing was stored either */
  }
}
