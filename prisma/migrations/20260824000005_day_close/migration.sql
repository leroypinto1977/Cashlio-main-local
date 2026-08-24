-- The end-of-day drawer count.
CREATE TABLE "DayClose" (
    "id" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "openingFloat" DECIMAL(10,2) NOT NULL,
    "expectedCash" DECIMAL(10,2) NOT NULL,
    "countedCash" DECIMAL(10,2) NOT NULL,
    "difference" DECIMAL(10,2) NOT NULL,
    "upiTotal" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "cardTotal" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "chequeTotal" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "billCount" INTEGER NOT NULL DEFAULT 0,
    "salesTotal" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "closedById" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DayClose_pkey" PRIMARY KEY ("id")
);

-- A day can only be closed once.
CREATE UNIQUE INDEX "DayClose_businessDate_key" ON "DayClose"("businessDate");
CREATE INDEX "DayClose_businessDate_idx" ON "DayClose"("businessDate");

ALTER TABLE "DayClose" ADD CONSTRAINT "DayClose_closedById_fkey"
    FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The day book reads every payment in a date window; without this it is a
-- sequential scan of the whole table once per day closed.
CREATE INDEX IF NOT EXISTS "Payment_receivedAt_idx" ON "Payment"("receivedAt");
