// Device-side leftovers of a signed-in account.
//
// The chat pages used to keep whole conversations in `localStorage` (`mt-chats:<user_id>`) — and
// those conversations are about salaries, debts and balances. Logging out cleared the cookie and
// left every word of that on the disk, readable by anyone who opens devtools on that machine
// afterwards. Signing out has to mean the device forgets too (security review 2026-07-26).
//
// Since §CHAT-SYNC (2026-08-07) conversations live on the server and the chat page deletes these
// keys as soon as it has imported them. This stays, and must: the keys are still on every device
// that has not opened the chat page since, and that is exactly the device someone signs out of.
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

/**
 * One-time sweep of keys belonging to features that no longer exist.
 *
 * Right now that is the local passcode (`mt-lock:<user_id>`), removed on 2026-08-14: nothing reads
 * it any more, so it cannot lock anyone out — but it is a hash of a code the owner chose, sitting
 * on the disk of every device they ever used, and "harmless because unused" is how leftovers stay
 * forever. Runs at boot rather than at logout, because the point is to reach devices that are
 * signed IN.
 */
const REMOVED_FEATURE_PREFIXES = ["mt-lock"];

export function sweepRemovedFeatureKeys(): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && REMOVED_FEATURE_PREFIXES.some((p) => key === p || key.startsWith(`${p}:`))) doomed.push(key);
    }
    for (const key of doomed) localStorage.removeItem(key);
    // `sessionStorage` held the "unlocked for this tab" marker.
    sessionStorage.removeItem("mt-unlocked");
  } catch {
    /* private mode / storage disabled — nothing was stored either */
  }
}
