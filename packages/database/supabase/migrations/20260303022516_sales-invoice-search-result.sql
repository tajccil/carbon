-- Fix invoice search result URLs
-- Sales invoices: /x/invoicing/sales/<id> -> /x/sales-invoice/<id>
-- Purchase invoices: /x/invoicing/purchasing/<id> -> /x/purchase-invoice/<id>

DO $$
DECLARE
  company_record RECORD;
  v_table_name TEXT;
BEGIN
  FOR company_record IN SELECT id FROM "company" LOOP
    v_table_name := 'searchIndex_' || company_record.id;

    EXECUTE format(
      'UPDATE %I SET "link" = ''/x/sales-invoice/'' || "entityId" WHERE "entityType" = ''salesInvoice''',
      v_table_name
    );

    EXECUTE format(
      'UPDATE %I SET "link" = ''/x/purchase-invoice/'' || "entityId" WHERE "entityType" = ''purchaseInvoice''',
      v_table_name
    );
  END LOOP;
END $$;
