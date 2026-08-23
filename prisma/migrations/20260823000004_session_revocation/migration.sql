-- Make signing someone out actually end their access.
--
-- A cashier's role was read from their token and never checked again, and
-- signing out only cleared the browser's local storage. A dismissed cashier
-- who kept their token — or the machine it was on — stayed a fully valid
-- SUPER_ADMIN for the remaining twelve hours. Deleting the account was not an
-- option either: their name is on every bill they ever made.
--
-- isActive ends access without touching the history. tokenVersion ends the
-- sessions that already exist, so a password change or a demotion takes hold
-- at the next request instead of at the next expiry.

ALTER TABLE "User"
  ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;

-- Let a till be taken off the branch. Until now a mistyped pairing or a
-- replaced machine held one of the licence's seats for good, and there was no
-- endpoint to release it. The row survives — bills name the terminal that rang
-- them up — but a retired one stops being counted.
ALTER TABLE "AuthorizedClient" ADD COLUMN "retiredAt" TIMESTAMP(3);
