-- One spelling of a MAC address, so one till.
--
-- A terminal reports whatever its operating system hands it, and that is not
-- consistent about case or separator: the same adapter reads
-- de:ad:be:ef:99:01 on one machine and DE:AD:BE:EF:99:01 on another. Stored
-- raw against a case-sensitive unique constraint, the same physical till
-- paired twice — two terminal codes, two rows in the device list, and two of
-- the licence's seats gone on one machine.
--
-- Existing rows are canonicalised to uppercase colon-separated form. Where
-- that reveals two rows for one device, the earlier one is kept and the later
-- one is retired rather than deleted, because bills name the terminal they
-- were rung up on.

-- Retire the later duplicate first, so canonicalising cannot collide.
WITH canon AS (
  SELECT "id", "authorizedAt",
         upper(regexp_replace("macAddress", '[^0-9a-fA-F]', '', 'g')) AS hex
    FROM "AuthorizedClient"
   WHERE "retiredAt" IS NULL
     AND length(regexp_replace("macAddress", '[^0-9a-fA-F]', '', 'g')) = 12
),
ranked AS (
  SELECT "id", hex,
         ROW_NUMBER() OVER (PARTITION BY hex ORDER BY "authorizedAt", "id") AS seat
    FROM canon
)
UPDATE "AuthorizedClient" c
   SET "retiredAt"   = NOW(),
       "terminalCode"= NULL,
       "macAddress"  = 'RETIRED:' || c."id",
       "friendlyName"= c."friendlyName" || ' (duplicate)'
  FROM ranked r
 WHERE c."id" = r."id" AND r.seat > 1;

-- Now every surviving device has a distinct address; rewrite them canonically.
UPDATE "AuthorizedClient" c
   SET "macAddress" = substr(h, 1, 2)  || ':' || substr(h, 3, 2)  || ':' ||
                      substr(h, 5, 2)  || ':' || substr(h, 7, 2)  || ':' ||
                      substr(h, 9, 2)  || ':' || substr(h, 11, 2)
  FROM (
    SELECT "id" AS cid,
           upper(regexp_replace("macAddress", '[^0-9a-fA-F]', '', 'g')) AS h
      FROM "AuthorizedClient"
     WHERE "retiredAt" IS NULL
  ) src
 WHERE c."id" = src.cid AND length(src.h) = 12;
