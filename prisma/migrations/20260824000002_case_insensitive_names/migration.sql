-- Stop "Finolex" and "finolex" becoming two brands.
--
-- Brand, category and warehouse names were unique, but Postgres compares text
-- case-sensitively, so the constraint never saw the collision. That defeats
-- the point of having a controlled list: the filter dropdown grows a second
-- entry, brand-wise reporting splits in half, and nobody can tell which is
-- which. Worse, saving a product that named a brand in a different case
-- created the duplicate silently, without anyone choosing to.
--
-- Existing duplicates are merged rather than rejected, because they are the
-- same thing under two spellings: the earliest row wins, everything pointing
-- at the others is repointed to it, and the duplicates go. Then a
-- case-insensitive index makes it impossible to do again, whichever code path
-- inserts.

-- ── Brands: repoint products, then drop the duplicate rows.
WITH ranked AS (
  SELECT "id", "name",
         FIRST_VALUE("id") OVER (PARTITION BY lower("name") ORDER BY "createdAt", "id") AS keeper
    FROM "Brand"
)
UPDATE "Product" p
   SET "brandId" = r.keeper,
       "brand"   = (SELECT "name" FROM "Brand" WHERE "id" = r.keeper)
  FROM ranked r
 WHERE p."brandId" = r."id" AND r."id" <> r.keeper;

DELETE FROM "Brand" b
 WHERE b."id" <> (
   SELECT b2."id" FROM "Brand" b2
    WHERE lower(b2."name") = lower(b."name")
    ORDER BY b2."createdAt", b2."id"
    LIMIT 1
 );

-- ── Categories: repoint products the same way.
WITH ranked AS (
  SELECT "id", "name",
         FIRST_VALUE("id") OVER (PARTITION BY lower("name") ORDER BY "createdAt", "id") AS keeper
    FROM "Category"
)
UPDATE "Product" p
   SET "categoryId" = r.keeper
  FROM ranked r
 WHERE p."categoryId" = r."id" AND r."id" <> r.keeper;

DELETE FROM "Category" c
 WHERE c."id" <> (
   SELECT c2."id" FROM "Category" c2
    WHERE lower(c2."name") = lower(c."name")
    ORDER BY c2."createdAt", c2."id"
    LIMIT 1
 );

-- ── Warehouses: repoint batches.
WITH ranked AS (
  SELECT "id", "name",
         FIRST_VALUE("id") OVER (PARTITION BY lower("name") ORDER BY "createdAt", "id") AS keeper
    FROM "Warehouse"
)
UPDATE "ProductBatch" b
   SET "warehouseId" = r.keeper
  FROM ranked r
 WHERE b."warehouseId" = r."id" AND r."id" <> r.keeper;

DELETE FROM "Warehouse" w
 WHERE w."id" <> (
   SELECT w2."id" FROM "Warehouse" w2
    WHERE lower(w2."name") = lower(w."name")
    ORDER BY w2."createdAt", w2."id"
    LIMIT 1
 );

CREATE UNIQUE INDEX "Brand_name_lower_key"     ON "Brand"     (lower("name"));
CREATE UNIQUE INDEX "Category_name_lower_key"  ON "Category"  (lower("name"));
CREATE UNIQUE INDEX "Warehouse_name_lower_key" ON "Warehouse" (lower("name"));
