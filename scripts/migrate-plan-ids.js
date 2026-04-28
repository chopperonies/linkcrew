// Renames legacy plan IDs to the 3-tier structure.
//
//   solo     -> crew
//   business -> pro   (max_users bumps 20 -> 15 per new pricing)
//   free, team, pro   unchanged (pro's max_users bumps 10 -> 15)
//
// Usage:
//   node fieldsync/scripts/migrate-plan-ids.js              # dry run
//   node fieldsync/scripts/migrate-plan-ids.js --apply      # writes changes
//
// Run AFTER deploying code that uses the new IDs (planFeatures.js et al.).

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
  process.exit(1);
}
const supabase = createClient(url, key);

const RENAMES = { solo: 'crew', business: 'pro' };
const NEW_MAX_USERS = { free: 1, crew: 1, team: 5, pro: 15 };

(async () => {
  const apply = process.argv.includes('--apply');

  const { data: tenants, error } = await supabase
    .from('tenants')
    .select('id, plan, max_users, company_name, subscription_status, created_at')
    .order('created_at');

  if (error) { console.error(error); process.exit(1); }

  const changes = [];
  for (const t of tenants) {
    const newPlan = RENAMES[t.plan] ?? t.plan;
    const planDefault = NEW_MAX_USERS[newPlan] ?? t.max_users;
    // Never reduce existing max_users — preserves any extra seats already provisioned
    // (e.g. legacy Business tenants with 20 keep 20 even though new Pro defaults to 15).
    const newMax = (t.max_users && t.max_users > planDefault) ? t.max_users : planDefault;
    if (newPlan !== t.plan || newMax !== t.max_users) {
      changes.push({
        id: t.id,
        name: t.company_name,
        status: t.subscription_status,
        oldPlan: t.plan, newPlan,
        oldMax: t.max_users, newMax,
      });
    }
  }

  console.log(`Tenants total:     ${tenants.length}`);
  console.log(`Tenants to change: ${changes.length}\n`);
  for (const c of changes) {
    const name = (c.name || '?').padEnd(30).slice(0, 30);
    console.log(`  ${c.id.slice(0, 8)}…  ${name}  [${c.status}]  ${c.oldPlan}/${c.oldMax} -> ${c.newPlan}/${c.newMax}`);
  }

  if (!changes.length) { console.log('Nothing to do.'); return; }

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to write.');
    return;
  }

  let ok = 0, fail = 0;
  for (const c of changes) {
    const { error } = await supabase
      .from('tenants')
      .update({ plan: c.newPlan, max_users: c.newMax })
      .eq('id', c.id);
    if (error) { fail++; console.error(`  fail ${c.id}: ${error.message}`); } else ok++;
  }
  console.log(`\nApplied: ${ok} ok · ${fail} fail`);
})();
