-- The structured publishing pipeline.
--
-- Three columns, and the reason each one is a column rather than something
-- computed at read time:
--
-- `link` is where a visitor actually gets the script when the publisher hosts
-- it themselves. It is the SECOND thing that has to stay behind the unlock —
-- the code was already gated, and a public link next to a gated code field
-- would have been a hole straight through the paywall. It lives beside `code`
-- and comes out of the same door.
--
-- `verified` is the site's own review verdict. It is deliberately NOT derived
-- from anything the publisher submits, because the moment it can be derived
-- from submitted content, a publisher can arrange to satisfy it.
--
-- `lua` records whether Luau syntax was detected in the submitted code, AT
-- PUBLISH TIME, by the server. It is a different claim from `verified` and the
-- UI must never merge them: this one says "this looks like code", not "we
-- checked it".
ALTER TABLE scripts ADD COLUMN link     TEXT    NOT NULL DEFAULT '';
ALTER TABLE scripts ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scripts ADD COLUMN lua      INTEGER NOT NULL DEFAULT 0;
