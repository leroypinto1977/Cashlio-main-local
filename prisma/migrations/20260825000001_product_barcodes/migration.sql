-- The codes a scanner can find a product by. Many per product, because the
-- same item really does carry more than one code in practice.
CREATE TABLE "ProductBarcode" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductBarcode_pkey" PRIMARY KEY ("id")
);

-- A scan must resolve to exactly one product.
CREATE UNIQUE INDEX "ProductBarcode_code_key" ON "ProductBarcode"("code");
CREATE INDEX "ProductBarcode_productId_idx" ON "ProductBarcode"("productId");

ALTER TABLE "ProductBarcode" ADD CONSTRAINT "ProductBarcode_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- At most one code per product may be the primary one. A partial unique index
-- says that in the schema rather than leaving it to every writer to remember.
CREATE UNIQUE INDEX "ProductBarcode_one_primary_per_product"
    ON "ProductBarcode"("productId") WHERE "isPrimary";
