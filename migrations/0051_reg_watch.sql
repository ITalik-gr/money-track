-- §TAX-WATCH — regulatory watch: the app follows official SOURCES and never becomes one.
--
-- THE PROBLEM, from life (owner, 2026-09-18): an acquaintance's payment requisites changed, nobody
-- told him, and the money went to the old account. Nothing in any finance app signals that.
--
-- THE TEMPTING WRONG SOLUTION is to ask a model for «the current requisites» and print them. An
-- IBAN is a string that strangers' money travels along; a model that gets one digit wrong does
-- exactly the harm this feature exists to prevent, and does it confidently. So the design is
-- inverted: we store a POINTER to the official page and a hash of what it said last time. When the
-- hash moves, the user gets a link and a date. The requisites themselves are only ever typed in by
-- the human, and carry the date THEY last checked.

CREATE TABLE reg_sources (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  url           TEXT    NOT NULL UNIQUE,
  label         TEXT    NOT NULL,
  topic         TEXT,                      -- 'requisites' | 'rates' | 'rules'
  region        TEXT,                      -- NULL = national; otherwise the user's own community
  content_hash  TEXT,
  last_checked  INTEGER,
  last_changed  INTEGER,
  -- Noise detector. A government page with a banner, a visitor counter or a date in the footer
  -- changes its hash every single day. A source that changes on several consecutive checks is
  -- marked noisy and stops raising events until a human looks at it: an alert that arrives daily
  -- is an alert people stop reading, and the real change then goes out with the rest.
  changes_in_row INTEGER NOT NULL DEFAULT 0,
  noisy         INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);

-- The user's OWN requisites, typed by the user. `verified_at` is the date a HUMAN last confirmed
-- them against the source — not the date a machine fetched anything. The card compares it with the
-- source's `last_changed`, and that comparison is the whole feature: «the page changed after you
-- last checked» is the sentence the owner's acquaintance never got to read.
CREATE TABLE tax_requisites (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT    NOT NULL,            -- 'single_tax' | 'military_levy' | 'social_contribution'
  iban        TEXT,
  recipient   TEXT,
  edrpou      TEXT,
  purpose     TEXT,                        -- «призначення платежу», the line banks reject without
  verified_at INTEGER,
  source_id   INTEGER REFERENCES reg_sources(id),
  updated_at  INTEGER NOT NULL,
  UNIQUE (kind)
);

-- Two national starting points. Seeds, NOT authority: every ФОП pays into their own community's
-- accounts, so the card tells the user to add their own region's page — and a seed URL that has
-- moved simply reports a fetch error on the card, which is visible rather than silent.
INSERT INTO reg_sources (url, label, topic, region, created_at) VALUES
  ('https://tax.gov.ua/rahunki-dlya-splati-platejiv/',
   'ДПС — рахунки для сплати платежів', 'requisites', NULL, CAST(strftime('%s','now') AS INTEGER)),
  ('https://tax.gov.ua/nove-pro-podatki--novini-/',
   'ДПС — новини про податки', 'rules', NULL, CAST(strftime('%s','now') AS INTEGER));
