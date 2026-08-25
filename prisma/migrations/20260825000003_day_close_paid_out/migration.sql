-- Cash paid out of the till, frozen with the rest of the count.
--
-- Expenses paid from the drawer now come off expected cash, so a day that was
-- previously short by exactly the courier's fee balances. Days closed before
-- this keep a zero, which is what they were reconciled against.
ALTER TABLE "DayClose" ADD COLUMN "cashPaidOut" DECIMAL(10,2) NOT NULL DEFAULT 0;
