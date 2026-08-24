-- Give revocation something to bite on.
--
-- The licence server hands out a token good for a week and the branch server
-- refreshes it twice a day. Revoking a licence changed a status column and
-- nothing else, so the token already sitting on the shop's disk stayed valid
-- for its full life — and a shop that simply blocked the domain kept billing
-- until the thirty-day offline grace ran out.
--
-- refreshTokenSeq is the counter the licence server bumps on revocation. A
-- token minted before the bump carries a lower number than the one the shop
-- has already seen, and a number that has gone backwards is refused. Sequences
-- only ever move forward, so reinstating bumps it again rather than rolling it
-- back: an old token can never be replayed to look current.
--
-- licenseLockReason carries the human explanation across, so the shop is told
-- what happened rather than left to guess.

ALTER TABLE "ShopConfig"
  ADD COLUMN "licenseLockReason" TEXT,
  ADD COLUMN "refreshTokenSeq" INTEGER NOT NULL DEFAULT 0;
