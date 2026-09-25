/**
 * §TAX-WATCH — the app never states a requisite: the watch only compares hashes, only a human sets
 * `verified_at`, an outage is an error (not a change), and URLs pass `isWatchableUrl()`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { migratedDb, type MemDb } from "./harness.ts";
import {
  checkSource, listSources, addSource,
  isWatchableUrl,
} from "../lib/finance/tax-watch.ts";

const NOW = Math.floor(Date.parse("2026-05-14T09:00:00.000Z") / 1000);
const DAY = 86_400;

/** Enough readable text to clear the «this is a block page» floor. */
const PAGE = (body: string) => `<html><head><style>.a{color:red}</style></head><body>
  <script>var build='${Math.random()}'</script>
  <p>${body}</p>
  <p>${"Реквізити для сплати єдиного податку та єдиного внеску. ".repeat(8)}</p>
</body></html>`;

function stubFetch(pages: string[]): () => void {
  const real = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async () => {
    const body = pages[Math.min(i++, pages.length - 1)]!;
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  return () => { globalThis.fetch = real; };
}

async function db(): Promise<MemDb> {
  const d = migratedDb();
  // The migration seeds two national sources; the tests drive their own.
  d.raw.prepare("DELETE FROM reg_sources").run();
  await addSource(d, { url: "https://example.gov.ua/req", label: "Реквізити", topic: "requisites" }, NOW);
  return d;
}

const only = async (d: MemDb) => (await listSources(d))[0]!;

test("an outage is an error on the card, never a phantom change", async () => {
  const d = await db();
  const restore = stubFetch([PAGE("жива сторінка")]);
  try { await checkSource(d, await only(d), NOW); } finally { restore(); }

  // A JS-only shell, a block page or an error dressed as a 200: hashing it would record a change
  // now and a second one when the real page returns — two false alarms from one outage.
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response("<html><body></body></html>", { status: 200 })) as typeof fetch;
  try {
    const r = await checkSource(d, await only(d), NOW + DAY);
    assert.equal(r.changed, false);
    assert.match(r.error ?? "", /no readable text/);
    assert.equal((await only(d)).last_changed, null, "the change date did not move");
  } finally { globalThis.fetch = real; }
});

/**
 * §PERIMETER — what the watch is allowed to fetch.
 *
 * Registration is OPEN, so the URL of a source is a stranger choosing a request the worker will
 * make from Cloudflare's network every night. The body never reaches them (this module only
 * hashes it), so the exposure is status probing rather than a content proxy — which is a reason
 * to keep it small, not a reason to allow it.
 */
test("the watch refuses a URL that is not a public https page (§PERIMETER)", () => {
  assert.ok(isWatchableUrl("https://tax.gov.ua/rahunki/"), "an official page is the whole point");
  assert.ok(isWatchableUrl("https://sub.dp.gov.ua/a?b=c#d"), "path, query and fragment are fine");

  assert.ok(!isWatchableUrl("http://tax.gov.ua/"), "http is refused: the page must not be editable in flight");
  assert.ok(!isWatchableUrl("https://127.0.0.1/admin"), "a loopback literal");
  assert.ok(!isWatchableUrl("https://[::1]/"), "and its IPv6 spelling");
  assert.ok(!isWatchableUrl("https://169.254.169.254/latest/meta-data/"), "the metadata address");
  // `new URL` normalises an integer host into dotted-quad form, so the plain shape check catches
  // the obfuscated spellings too rather than needing a list of them.
  assert.ok(!isWatchableUrl("https://2130706433/"), "127.0.0.1 written as one integer");
  assert.ok(!isWatchableUrl("https://localhost/"), "a name with no dot is not a publication");
  assert.ok(!isWatchableUrl("https://kv.internal/req"), "nor an internal search domain");
  assert.ok(!isWatchableUrl("file:///etc/passwd"), "nor another scheme entirely");
  assert.ok(!isWatchableUrl("not a url"), "nor a string that is not one");
});

test("a redirect into somewhere unwatchable is an error, not a hash", async () => {
  const d = await db();
  const real = globalThis.fetch;
  // What a remote host can do that the insert-time check cannot see: answer the public URL with a
  // 302 and let `fetch` follow it. The `url` of the response is where it LANDED.
  globalThis.fetch = (async () => {
    const res = new Response(PAGE("whatever"), { status: 200 });
    Object.defineProperty(res, "url", { value: "https://127.0.0.1/secret" });
    return res;
  }) as typeof fetch;
  try {
    const r = await checkSource(d, await only(d), NOW);
    assert.equal(r.changed, false);
    assert.match(String(r.error), /not watchable/);
    assert.equal((await only(d)).content_hash, null, "and nothing was recorded about that page");
  } finally { globalThis.fetch = real; }
});
