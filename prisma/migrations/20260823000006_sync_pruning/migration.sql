-- Let the change log be trimmed safely.
--
-- SyncEvent is append-only and nothing removed rows, so every price edit,
-- customer change and bill since the shop opened stayed in it forever, each
-- carrying a full JSON snapshot of the row it describes — inside the database
-- that also gets dumped twice a day.
--
-- Deleting by age alone would be a guess: a till switched off for a month
-- would come back to find the changes it slept through gone, with no way to
-- know it had missed them. Recording how far each till has read means the log
-- can be trimmed to the point every one of them has passed, which by
-- definition no till can ask for again.
ALTER TABLE "AuthorizedClient"
  ADD COLUMN "syncCursorTxid" BIGINT,
  ADD COLUMN "lastSyncAt" TIMESTAMP(3);
