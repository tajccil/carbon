-- Clean up orphaned employee memberships
DELETE FROM membership m
WHERE m."memberUserId" IS NOT NULL
AND EXISTS (
  SELECT 1 FROM "group" g
  WHERE g.id = m."groupId"
  AND g."isEmployeeTypeGroup" = true
)
AND NOT EXISTS (
  SELECT 1 FROM employee e
  WHERE e.id = m."memberUserId"
);

-- Clean up orphaned customer memberships
DELETE FROM membership m
WHERE m."memberUserId" IS NOT NULL
AND EXISTS (
  SELECT 1 FROM "group" g
  WHERE g.id = m."groupId"
  AND g."isCustomerOrgGroup" = true
)
AND NOT EXISTS (
  SELECT 1 FROM "customerAccount" ca
  WHERE ca.id = m."memberUserId"
);

-- Clean up orphaned supplier memberships
DELETE FROM membership m
WHERE m."memberUserId" IS NOT NULL
AND EXISTS (
  SELECT 1 FROM "group" g
  WHERE g.id = m."groupId"
  AND g."isSupplierOrgGroup" = true
)
AND NOT EXISTS (
  SELECT 1 FROM "supplierAccount" sa
  WHERE sa.id = m."memberUserId"
);
