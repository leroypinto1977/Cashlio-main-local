-- Index the tables the shop reads every day.
--
-- Prisma does not create indexes for foreign keys, and Bill, BillItem and
-- Payment had none at all beyond their primary keys. Every screen that lists
-- or totals sales was therefore a full scan and a sort of the entire table:
-- instant at a thousand bills, and several seconds within a year of ordinary
-- trading. These are cheap to add now and painful to add later, when the
-- table they lock is the one the shop is billing against.
--
-- CONCURRENTLY is deliberately not used: these run at startup on a local
-- database with nobody connected, and concurrent builds cannot run inside the
-- transaction Prisma wraps a migration in.

CREATE INDEX "Bill_paidAt_idx"             ON "Bill"("paidAt");
CREATE INDEX "Bill_status_paidAt_idx"      ON "Bill"("status", "paidAt");
CREATE INDEX "Bill_customerId_paidAt_idx"  ON "Bill"("customerId", "paidAt");
CREATE INDEX "Bill_cashierId_paidAt_idx"   ON "Bill"("cashierId", "paidAt");
CREATE INDEX "Bill_originalBillId_idx"     ON "Bill"("originalBillId");
CREATE INDEX "Bill_originDeviceId_idx"     ON "Bill"("originDeviceId");

CREATE INDEX "BillItem_billId_idx"             ON "BillItem"("billId");
CREATE INDEX "BillItem_productId_idx"          ON "BillItem"("productId");
CREATE INDEX "BillItem_originalBillItemId_idx" ON "BillItem"("originalBillItemId");

CREATE INDEX "Payment_method_receivedAt_idx" ON "Payment"("method", "receivedAt");
CREATE INDEX "Payment_receivedAt_idx"        ON "Payment"("receivedAt");
