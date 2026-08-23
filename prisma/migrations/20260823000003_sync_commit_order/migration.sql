-- Page the sync log by commit order, not by sequence order.
--
-- "id" comes from a BIGSERIAL, which hands out numbers when a row is inserted
-- and tells you nothing about when its transaction commits. Two concurrent
-- sales can take 100 and 101 and commit in the other order; a terminal that
-- pulls in between sees 101, moves its cursor past it, and never learns about
-- 100. The bill exists on the branch server and on no till.
--
-- Recording the writing transaction lets the reader serve only rows whose
-- transaction has certainly finished, ordered by (txid, id) — an order no
-- later commit can insert itself into behind an already-served row.

ALTER TABLE "SyncEvent"
  ADD COLUMN "txid" BIGINT NOT NULL DEFAULT (pg_current_xact_id())::text::bigint;

-- Rows written before this migration are all long committed, so they sort
-- first. 0 also keeps old id-only cursors meaningful: "42" reads as (0, 42).
UPDATE "SyncEvent" SET "txid" = 0;

CREATE INDEX "SyncEvent_txid_id_idx" ON "SyncEvent"("txid", "id");
