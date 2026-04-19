-- Service PRO: seed 3 additional global templates (Landscaping, Cleaning, Electrician).
-- Idempotent — deletes these 3 by name first, then re-inserts.
-- Tenant clones (is_template = false) are untouched.

-- 1) Clean slate
DELETE FROM service_workflows
WHERE tenant_id IS NULL
  AND is_template = true
  AND name IN (
    'Landscaping',
    'Residential Cleaning',
    'Electrical Service'
  );

-- 2) Insert workflow rows
INSERT INTO service_workflows (tenant_id, name, description, industry, is_template)
VALUES
  (NULL, 'Landscaping',
   'Lawn, yard, and grounds work: quote, schedule, drive, complete, invoice.',
   'landscaping', true),
  (NULL, 'Residential Cleaning',
   'House cleaning visits: booked, en route, cleaning, walkthrough, paid.',
   'cleaning', true),
  (NULL, 'Electrical Service',
   'Electrical service calls: dispatch, diagnose, permit, wire, inspect, invoice.',
   'electrical', true);

-- 3) Insert workflow_statuses
WITH tpl AS (
  SELECT
    (SELECT id FROM service_workflows
     WHERE tenant_id IS NULL AND is_template = true
       AND name = 'Landscaping') AS landscaping_id,
    (SELECT id FROM service_workflows
     WHERE tenant_id IS NULL AND is_template = true
       AND name = 'Residential Cleaning') AS cleaning_id,
    (SELECT id FROM service_workflows
     WHERE tenant_id IS NULL AND is_template = true
       AND name = 'Electrical Service') AS electrical_id
)
INSERT INTO workflow_statuses
  (workflow_id, order_index, name, color, icon, steps, action_buttons, legacy_status)
-- ========== LANDSCAPING ==========
SELECT landscaping_id, 1, 'Quote Sent', '#8b5cf6', 'send',
  jsonb_build_array(
    jsonb_build_object('order', 1, 'label', 'Walk property and measure scope', 'required', true),
    jsonb_build_object('order', 2, 'label', 'Send written estimate to customer', 'required', true),
    jsonb_build_object('order', 3, 'label', 'Follow up if no response in 3 days', 'required', false)
  ),
  jsonb_build_array(
    jsonb_build_object('label', 'Call Customer', 'action_type', 'call_customer', 'style', 'ghost'),
    jsonb_build_object('label', 'Generate Estimate', 'action_type', 'generate_estimate', 'style', 'primary_solid')
  ),
  'lead'
FROM tpl
UNION ALL
SELECT landscaping_id, 2, 'Scheduled', '#3b82f6', 'calendar',
  jsonb_build_array(
    jsonb_build_object('order', 1, 'label', 'Confirm date with customer', 'required', true),
    jsonb_build_object('order', 2, 'label', 'Verify gate code or access', 'required', false)
  ),
  jsonb_build_array(
    jsonb_build_object('label', 'Call Customer', 'action_type', 'call_customer', 'style', 'ghost')
  ),
  'scheduled'
FROM tpl
UNION ALL
SELECT landscaping_id, 3, 'On the Way', '#ec4899', 'truck',
  jsonb_build_array(
    jsonb_build_object('order', 1, 'label', 'Load equipment (mower, trimmer, blower)', 'required', true),
    jsonb_build_object('order', 2, 'label', 'Send ETA to customer', 'required', true)
  ),
  jsonb_build_array(
    jsonb_build_object('label', 'Navigate', 'action_type', 'navigate', 'style', 'ghost')
  ),
  'in_progress'
FROM tpl
UNION ALL
SELECT landscaping_id, 4, 'On Site', '#f59e0b', 'hard-hat',
  jsonb_build_array(
    jsonb_build_object('order', 1, 'label', 'Take before photos', 'required', true),
    jsonb_build_object('order', 2, 'label', 'Mow and edge', 'required', true),
    jsonb_build_object('order', 3, 'label', 'Trim hedges / shrubs', 'required', false),
    jsonb_build_object('order', 4, 'label', 'Blow clippings and clean up', 'required', true),
    jsonb_build_object('order', 5, 'label', 'Take after photos', 'required', true)
  ),
  jsonb_build_array(
    jsonb_build_object('label', 'Open Camera', 'action_type', 'open_camera', 'style', 'ghost'),
    jsonb_build_object('label', 'Add Note', 'action_type', 'add_note', 'style', 'ghost')
  ),
  'in_progress'
FROM tpl
UNION ALL
SELECT landscaping_id, 5, 'Complete', '#0f766e', 'check-circle',
  jsonb_build_array(
    jsonb_build_object('order', 1, 'label', 'Walk customer through work', 'required', true),
    jsonb_build_object('order', 2, 'label', 'Confirm satisfaction', 'required', true),
    jsonb_build_object('order', 3, 'label', 'Create invoice', 'required', true)
  ),
  jsonb_build_array(
    jsonb_build_object('label', 'Generate Estimate', 'action_type', 'generate_estimate', 'style', 'primary_solid'),
    jsonb_build_object('label', 'Add Note', 'action_type', 'add_note', 'style', 'ghost')
  ),
  'completed'
FROM tpl
UNION ALL
SELECT landscaping_id, 6, 'Invoiced', '#64748b', 'file-check',
  jsonb_build_array(
    jsonb_build_object('order', 1, 'label', 'Invoice sent', 'required', true)
  ),
  '[]'::jsonb,
  'invoiced'
FROM tpl
-- ========== CLEANING ==========
UNION ALL
SELECT cleaning_id, 1, 'Booked', '#3b82f6', 'calendar',
  jsonb_build_array(
    jsonb_build_object('order', 1, 'label', 'Confirm date and access', 'required', true),
    jsonb_build_object('order', 2, 'label', 'Confirm pet / alarm notes', 'required', false)
  ),
  jsonb_build_array(
    jsonb_build_object('label', 'Call Customer', 'action_type', 'call_customer', 'style', 'ghost')
  ),
  'scheduled'
FROM tpl
UNION ALL
SELECT cleaning_id, 2, 'En Route', '#ec4899', 'truck',
  jsonb_build_array(
    jsonb_build_object('order', 1, 'label', 'Load supplies and vacuum', 'required', true),
    jsonb_build_object('order', 2, 'label', 'Send ETA to customer', 'required', true)
  ),
  jsonb_build_array(
    jsonb_build_object('label', 'Navigate', 'action_type', 'navigate', 'style', 'ghost')
  ),
  'in_progress'
FROM tpl
UNION ALL
SELECT cleaning_id, 3, 'Cleaning', '#16a34a', 'home',
  jsonb_build_array(
    jsonb_build_object('order', 1, 'label', 'Take before photos', 'required', true),
    jsonb_build_object('order', 2, 'label', 'Kitchen', 'required', true),
    jsonb_build_object('order', 3, 'label', 'Bathrooms', 'required', true),
    jsonb_build_object('order', 4, 'label', 'Bedrooms and living areas', 'required', true),
    jsonb_build_object('order', 5, 'label', 'Floors (vacuum and mop)', 'required', true),
    jsonb_build_object('order', 6, 'label', 'Take after photos', 'required', true)
  ),
  jsonb_build_array(
    jsonb_build_object('label', 'Open Camera', 'action_type', 'open_camera', 'style', 'ghost'),
    jsonb_build_object('label', 'Add Note', 'action_type', 'add_note', 'style', 'ghost')
  ),
  'in_progress'
FROM tpl
UNION ALL
SELECT cleaning_id, 4, 'Walkthrough', '#f59e0b', 'check-circle',
  jsonb_build_array(
    jsonb_build_object('order', 1, 'label', 'Walk customer through house', 'required', true),
    jsonb_build_object('order', 2, 'label', 'Address any touch-ups', 'required', false)
  ),
  jsonb_build_array(
    jsonb_build_object('label', 'Call Customer', 'action_type', 'call_customer', 'style', 'ghost'),
    jsonb_build_object('label', 'Add Note', 'action_type', 'add_note', 'style', 'ghost')
  ),
  'in_progress'
FROM tpl
UNION ALL
SELECT cleaning_id, 5, 'Paid', '#0f766e', 'dollar-sign',
  jsonb_build_array(
    jsonb_build_object('order', 1, 'label', 'Collect payment or send invoice', 'required', true)
  ),
  '[]'::jsonb,
  'completed'
FROM tpl
-- ========== ELECTRICAL ==========
UNION ALL
SELECT electrical_id, 1, 'Dispatched', '#3b82f6', 'send',
  jsonb_build_array(
    jsonb_build_object('order', 1, 'label', 'Review customer issue and access', 'required', true),
    jsonb_build_object('order', 2, 'label', 'Confirm ETA with customer', 'required', true)
  ),
  jsonb_build_array(
    jsonb_build_object('label', 'Call Customer', 'action_type', 'call_customer', 'style', 'ghost'),
    jsonb_build_object('label', 'Navigate', 'action_type', 'navigate', 'style', 'ghost')
  ),
  'scheduled'
FROM tpl
UNION ALL
SELECT electrical_id, 2, 'On Site', '#ec4899', 'map-pin',
  jsonb_build_array(
    jsonb_build_object('order', 1, 'label', 'Arrive and greet customer', 'required', true),
    jsonb_build_object('order', 2, 'label', 'Photograph panel and affected area', 'required', true),
    jsonb_build_object('order', 3, 'label', 'Verify power state before work', 'required', true)
  ),
  jsonb_build_array(
    jsonb_build_object('label', 'Open Camera', 'action_type', 'open_camera', 'style', 'ghost')
  ),
  'in_progress'
FROM tpl
UNION ALL
SELECT electrical_id, 3, 'Diagnosing', '#f59e0b', 'search',
  jsonb_build_array(
    jsonb_build_object('order', 1, 'label', 'Test circuits and identify fault', 'required', true),
    jsonb_build_object('order', 2, 'label', 'Document findings', 'required', true),
    jsonb_build_object('order', 3, 'label', 'Present repair options and price', 'required', true)
  ),
  jsonb_build_array(
    jsonb_build_object('label', 'Add Note', 'action_type', 'add_note', 'style', 'ghost'),
    jsonb_build_object('label', 'Generate Estimate', 'action_type', 'generate_estimate', 'style', 'primary_solid')
  ),
  'in_progress'
FROM tpl
UNION ALL
SELECT electrical_id, 4, 'Permit / Pull', '#8b5cf6', 'file-check',
  jsonb_build_array(
    jsonb_build_object('order', 1, 'label', 'Pull permit if required', 'required', false),
    jsonb_build_object('order', 2, 'label', 'Confirm inspection window with customer', 'required', false)
  ),
  jsonb_build_array(
    jsonb_build_object('label', 'Add Note', 'action_type', 'add_note', 'style', 'ghost')
  ),
  'in_progress'
FROM tpl
UNION ALL
SELECT electrical_id, 5, 'Wiring', '#16a34a', 'zap',
  jsonb_build_array(
    jsonb_build_object('order', 1, 'label', 'De-energize and lock out', 'required', true),
    jsonb_build_object('order', 2, 'label', 'Perform wiring / install', 'required', true),
    jsonb_build_object('order', 3, 'label', 'Test circuit under load', 'required', true),
    jsonb_build_object('order', 4, 'label', 'Take after photos', 'required', true)
  ),
  jsonb_build_array(
    jsonb_build_object('label', 'Open Camera', 'action_type', 'open_camera', 'style', 'ghost'),
    jsonb_build_object('label', 'If Needed, Create PO', 'action_type', 'create_po', 'style', 'ghost')
  ),
  'in_progress'
FROM tpl
UNION ALL
SELECT electrical_id, 6, 'Inspection', '#0f766e', 'clipboard',
  jsonb_build_array(
    jsonb_build_object('order', 1, 'label', 'Walk customer through work', 'required', true),
    jsonb_build_object('order', 2, 'label', 'Collect signature', 'required', true),
    jsonb_build_object('order', 3, 'label', 'Final inspection if permit pulled', 'required', false)
  ),
  jsonb_build_array(
    jsonb_build_object('label', 'Add Note', 'action_type', 'add_note', 'style', 'ghost')
  ),
  'completed'
FROM tpl
UNION ALL
SELECT electrical_id, 7, 'Invoiced', '#64748b', 'file-check',
  jsonb_build_array(
    jsonb_build_object('order', 1, 'label', 'Invoice sent', 'required', true)
  ),
  '[]'::jsonb,
  'invoiced'
FROM tpl;
