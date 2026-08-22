/**
 * Telegram as a SECOND KEY to an account that already exists.
 *
 * The problem it solves is narrow and was reported from a phone: the app opened as a Telegram Mini
 * App cannot sign in with Google. The OAuth `state` cookie never comes back — Telegram opens the
 * consent screen in an outside browser and the session does not travel back into the webview — so
 * the callback fails `bad_state` every time, which reads as «Google is broken» rather than as
 * «this environment cannot do OAuth».
 *
 * ⚠️ **This is not a second way to REGISTER.** An account is still born through Google alone
 * (`loginWithGoogle`), so there is exactly one identity, one email, one `google_sub`, and nothing
 * here can create anything. What Telegram proves is «I am the person who linked this chat» — and
 * the answer to «whose chat is this» stays where it already lived, `tg_links` in the directory.
 * A second index (telegram user → account) would be a second copy of one fact, which is the shape
 * this codebase spent 2026-08-21 removing.
 *
 * ⚠️ **The identity is only usable because a link is PRIVATE-ONLY.** Telegram gives a private chat
 * the same id as the user, so a `tg_links` row is simultaneously «this chat» and «this person».
 * That equivalence is what linking in a group would break — and why it is refused outright
 * (`routes/telegram.ts`): a group row here would let anyone in that group sign in as its owner.
 */

/** The only field of `initData.user` this app has any use for. */
export interface TgWebAppUser {
  id: number;
  first_name?: string;
  username?: string;
}

async function hmacBytes(key: ArrayBuffer | Uint8Array, msg: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey(
    "raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
}

const toHex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/**
 * Verify Telegram's `initData` and return the user it names, or `null`.
 *
 * The scheme is Telegram's: the signing key is `HMAC(key = "WebAppData", msg = botToken)`, and the
 * signed payload is every field except `hash`, as `key=value`, sorted, newline-joined. Getting the
 * key derivation backwards still produces a hex string of the right length, so the only way to know
 * it is right is a fixture — see `tg-auth.test.ts`.
 *
 * ⚠️ `auth_date` is checked because a signature never expires on its own. The window is a DAY,
 * matching Telegram's own guidance: `initData` is minted when the mini app launches and does not
 * refresh while it is open, so a short window would sign people out mid-use — and it would buy
 * nothing, since whoever can read the string can use it immediately.
 */
export async function verifyInitData(
  botToken: string, initData: string, now = Date.now(), maxAgeSec = 86400,
): Promise<TgWebAppUser | null> {
  if (!botToken || !initData) return null;

  let params: URLSearchParams;
  try { params = new URLSearchParams(initData); } catch { return null; }

  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  // ⚠️ `hash` is the ONLY field removed. `signature` (Bot API 8.0) is a received field like any
  // other and is part of THIS check-string — only Telegram's separate Ed25519 third-party scheme
  // excludes it, and the documentation says so in that section alone. Dropping it here is what
  // made every launch from a current client fail `bad_init_data` while the fixture below passed:
  // the test built its own payload, so it agreed with whatever the code did.

  const check = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");

  const secret = await hmacBytes(new TextEncoder().encode("WebAppData"), botToken);
  const expected = toHex(await hmacBytes(secret, check));
  if (expected.length !== hash.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ hash.charCodeAt(i);
  if (diff !== 0) return null;

  const authDate = Number(params.get("auth_date") ?? 0);
  if (!authDate || now / 1000 - authDate > maxAgeSec) return null;
  // A clock ahead of ours by more than a minute means the payload was not minted by a normal
  // client run; the signature says nothing about that, and future-dated data would outlive its
  // window in the direction the check above cannot see.
  if (authDate - now / 1000 > 60) return null;

  try {
    const user = JSON.parse(params.get("user") ?? "null") as TgWebAppUser | null;
    return user && Number.isFinite(user.id) ? user : null;
  } catch { return null; }
}
