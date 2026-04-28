// Single source of truth for plan tiers, included seats, feature gates, and voice metering caps.
//
// Plan IDs: free | crew | team | pro
// Migrated from legacy IDs (solo->crew, business->pro) on 2026-04-28 via scripts/migrate-plan-ids.js.
//
// FEATURES is consumed by the requireFeature middleware (wired in step 3-4 of PR #1).
// VOICE_* constants are consumed by voiceUsage.js (PR #2).

const PLAN_TIER = {
  free: 0,
  crew: 1,
  team: 2,
  pro:  3,
};

const PLAN_MAX_USERS = {
  free: 1,
  crew: 1,
  team: 5,
  pro:  15,
};

// Lowest plan that includes each feature. Future-state values; not consumed by any caller yet.
const FEATURES = {
  crew_checkins:   'team',
  per_crew_photos: 'team',
  daily_digest:    'team',
  appt_reminders:  'team',
  reports:         'team',
  gps_punch:       'team',
  custom_branding: 'team',
  voice_bot:       'pro',
  two_way_sms:     'pro',
  qbo_sync:        'pro',
};

function hasFeature(plan, feature) {
  const required = FEATURES[feature];
  if (!required) return true;
  return (PLAN_TIER[plan] ?? 0) >= (PLAN_TIER[required] ?? Infinity);
}

// Voice metering caps — applied post-migration. See linkcrew_voice_fair_use.md.
const VOICE_MINUTES_INCLUDED = {
  crew: 0,
  team: 0,
  pro:  500,
};
const VOICE_ADDON_MINUTES = 200;
const VOICE_OVERAGE_PER_MIN = 0.05;

module.exports = {
  PLAN_TIER,
  PLAN_MAX_USERS,
  FEATURES,
  hasFeature,
  VOICE_MINUTES_INCLUDED,
  VOICE_ADDON_MINUTES,
  VOICE_OVERAGE_PER_MIN,
};
