/**
 * §TAX-WATCH — the regulatory watch (docs/TAX.md §0.2).
 *
 * The property under test is mostly a NEGATIVE one: the app must never be the thing that states a
 * payment requisite. There is no assertion that proves an absence, so these tests pin the
 * mechanics that make the absence structural — the watch only ever compares hashes, the human's
 * confirmation is the only thing that sets `verified_at`, and «the source moved after you checked»
 * is computed from those two dates and nothing else.
 *
 * The network is stubbed here. `checkSource` is the one function in the project that fetches a
 * third party's page, and a test that reached tax.gov.ua would fail on their maintenance window
 * rather than on our bug.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { migratedDb, type MemDb } from "./harness.ts";
import {
  normalizeHtml, checkSource, listSources, listRequisites, upsertRequisite, unmuteSource, addSource,
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

test("normalisation drops what changes on every deploy of someone else's site", () => {
  const a = normalizeHtml("<style>.x{}</style><script>var b='111'</script><p>Ставка 5%</p>");
  const b = normalizeHtml("<style>.x{}</style><script>var b='222'</script><p>Ставка  5%</p>");
  assert.equal(a, b, "a cache-busting build id is not a change in the rules");
  assert.equal(a, "Ставка 5%");
});

test("the FIRST check stores a baseline and says nothing", async () => {
  const d = await db();
  const restore = stubFetch([PAGE("перша версія")]);
  try {
    const r = await checkSource(d, await only(d), NOW);
    assert.equal(r.changed, false, "there is nothing to compare against yet");
    const src = await only(d);
    assert.ok(src.content_hash, "but the baseline is recorded");
    assert.equal(src.last_changed, null);
  } finally { restore(); }
});

test("a real edit raises a change; an identical page does not", async () => {
  const d = await db();
  let restore = stubFetch([PAGE("стара редакція")]);
  try { await checkSource(d, await only(d), NOW); } finally { restore(); }

  restore = stubFetch([PAGE("стара редакція")]);
  try {
    assert.equal((await checkSource(d, await only(d), NOW + DAY)).changed, false, "same text, no event");
  } finally { restore(); }

  restore = stubFetch([PAGE("НОВІ реквізити з 1 червня")]);
  try {
    const r = await checkSource(d, await only(d), NOW + 2 * DAY);
    assert.equal(r.changed, true);
    assert.equal((await only(d)).last_changed, NOW + 2 * DAY);
  } finally { restore(); }
});

test("a page that changes every day goes quiet instead of becoming wallpaper", async () => {
  const d = await db();
  // A footer date or a visitor counter moves the hash on every single check. Three in a row is
  // not «the law changed three times», it is a page that cannot be watched this way.
  for (let i = 0; i <= 3; i++) {
    const restore = stubFetch([PAGE(`редакція ${i}`)]);
    try { await checkSource(d, await only(d), NOW + i * DAY); } finally { restore(); }
  }
  const src = await only(d);
  assert.equal(src.noisy, 1, "marked noisy after three consecutive changes");

  // It keeps RECORDING while quiet — the date still moves, so the «check this» comparison below
  // stays truthful even for a source that is too noisy to announce.
  const restore = stubFetch([PAGE("ще одна редакція")]);
  try {
    const r = await checkSource(d, await only(d), NOW + 9 * DAY);
    assert.equal(r.changed, true);
    assert.equal(r.suppressed, true, "recorded, not announced");
  } finally { restore(); }

  await unmuteSource(d, src.id);
  assert.equal((await only(d)).noisy, 0, "a human can decide it is worth watching again");
});

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

test("«the source moved after you checked» needs BOTH dates, and unverified is not stale", async () => {
  const d = await db();
  const src = await only(d);

  await upsertRequisite(d, { kind: "single_tax", iban: "UA00...", source_id: src.id, verified: false }, NOW);
  let [req] = await listRequisites(d);
  assert.equal(req.verified_at, null);
  assert.equal(req.stale, false, "never checked is a different sentence from changed since checked");

  await upsertRequisite(d, { kind: "single_tax", iban: "UA00...", source_id: src.id, verified: true }, NOW);
  [req] = await listRequisites(d);
  assert.equal(req.verified_at, NOW);
  assert.equal(req.stale, false);

  // The source moves a week later — this is the line the owner's acquaintance never got to read.
  let restore = stubFetch([PAGE("базова")]);
  try { await checkSource(d, await only(d), NOW); } finally { restore(); }
  restore = stubFetch([PAGE("реквізити змінено")]);
  try { await checkSource(d, await only(d), NOW + 7 * DAY); } finally { restore(); }

  [req] = await listRequisites(d);
  assert.equal(req.stale, true);
  assert.equal(req.source_changed_at, NOW + 7 * DAY, "the card can link the change, not just assert it");

  // Confirming again clears it — and only a human act does that.
  await upsertRequisite(d, { kind: "single_tax", iban: "UA11...", source_id: src.id, verified: true }, NOW + 8 * DAY);
  [req] = await listRequisites(d);
  assert.equal(req.stale, false);
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
