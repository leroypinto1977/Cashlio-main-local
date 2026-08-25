-- Money going out that is not stock, so the margin figure can be stated net.

CREATE TABLE "ExpenseCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'FIXED',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpenseCategory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExpenseCategory_name_key" ON "ExpenseCategory"("name");
-- Case-insensitively unique, like every other controlled list here: a total by
-- category is worthless if "Rent" and "rent" are two rows.
CREATE UNIQUE INDEX "ExpenseCategory_name_lower_key" ON "ExpenseCategory" (lower("name"));
CREATE INDEX "ExpenseCategory_isActive_idx" ON "ExpenseCategory"("isActive");

CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "gstAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "paidOn" DATE NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'CASH',
    "paidFromTill" BOOLEAN NOT NULL DEFAULT false,
    "payee" TEXT,
    "reference" TEXT,
    "notes" TEXT,
    "isRecurring" BOOLEAN NOT NULL DEFAULT false,
    "recordedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- Every read is a date range, usually narrowed to a category. The till index
-- backs the day book, which asks only for cash taken out of the drawer.
CREATE INDEX "Expense_paidOn_idx" ON "Expense"("paidOn");
CREATE INDEX "Expense_categoryId_paidOn_idx" ON "Expense"("categoryId", "paidOn");
CREATE INDEX "Expense_paidFromTill_paidOn_idx" ON "Expense"("paidFromTill", "paidOn");

ALTER TABLE "Expense" ADD CONSTRAINT "Expense_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "ExpenseCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_recordedById_fkey"
    FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The costs a counter shop actually has. Seeded rather than left empty,
-- because an empty category list means the first expense somebody tries to
-- record turns into a detour through a settings screen — and the one after
-- that gets typed into notes instead.
INSERT INTO "ExpenseCategory" ("id", "name", "kind") VALUES
    (gen_random_uuid(), 'Rent',                    'FIXED'),
    (gen_random_uuid(), 'Salaries & wages',        'FIXED'),
    (gen_random_uuid(), 'Electricity',             'FIXED'),
    (gen_random_uuid(), 'Internet & phone',        'FIXED'),
    (gen_random_uuid(), 'Shop supplies',           'VARIABLE'),
    (gen_random_uuid(), 'Transport & freight',     'VARIABLE'),
    (gen_random_uuid(), 'Repairs & maintenance',   'VARIABLE'),
    (gen_random_uuid(), 'Bank & payment charges',  'VARIABLE'),
    (gen_random_uuid(), 'Professional fees',       'FIXED'),
    (gen_random_uuid(), 'Marketing',               'VARIABLE'),
    (gen_random_uuid(), 'Other',                   'VARIABLE');
