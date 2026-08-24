-- The classification code a GST return is filed on.
--
-- A GST invoice above the turnover threshold has to carry an HSN code per
-- line, and GSTR-1's HSN summary is grouped by it. Neither the product nor the
-- bill line had anywhere to put one, so the shop could bill correctly all year
-- and still be unable to file — which means keeping a second set of books
-- somewhere else, and that defeats the point of the first.
--
-- It lands in two places on purpose. On the product, because that is where
-- somebody maintains it. On the bill line as well, snapshotted at the moment
-- of sale beside the item code and name that are already copied there: a
-- product's HSN can be corrected next month, and the invoice already handed to
-- a customer — and the return filed from it — must not change underneath.

ALTER TABLE "Product"  ADD COLUMN "hsnCode" TEXT;
ALTER TABLE "BillItem" ADD COLUMN "hsnCode" TEXT;

-- Grouping the HSN summary reads every line of a period.
CREATE INDEX "BillItem_hsnCode_idx" ON "BillItem"("hsnCode");
