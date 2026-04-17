# LinkCrew — Handoff 2026-04-16

Long working session. ~25 commits on main. Sandbox still in place for Stripe; no live cutover yet.

## What shipped today

### Stripe Connect Standard — sandbox-verified end-to-end
- OAuth routes on server.js (`/api/stripe/connect/start` / `/callback` / `/disconnect` / `/status`).
- `/portal/api/checkout` now requires Connect (rejects if tenant not connected), routes payment to the connected account with `application_fee_amount=0`.
- Webhook handlers: `checkout.session.completed`, `account.updated` (only restricts on `charges_enabled=false` — loosened mid-session), `account.application.deauthorized`.
- Admin panel shows per-tenant Connect chip (green ✓ / amber restricted / grey none).
- Payment methods CRUD + QR upload (Zelle/Venmo/PayPal/Cash App/ACH/check) backed by `tenants.payment_methods` jsonb + `payment-qrs` Supabase Storage bucket.
- Invoice header: tenant logo if uploaded, otherwise company name only (no LinkCrew logo fallback). Footer: "Invoicing powered by LinkCrew".
- Client receipt email on successful payment (tenant-branded).
- `/payment-setup` guide page.
- Fixed redirect URI (trust proxy + force https for non-localhost), 60-min state TTL for OAuth.
- Supabase migration applied: `stripe_connect_account_id`, `stripe_connect_status`, `payment_methods`.

### Mobile-responsive dashboard
- Bottom nav at 60px, only real nav items (hid chrome: Signed-in card, live indicator, invite + signout buttons moved to topbar user menu).
- Topbar user menu button (`≤900px`) with Signed-in info + Settings + Sign Out.
- Topbar brand logo on mobile — tenant logo + name with LinkCrew fallback, live-updates on logo change.
- Calendar 5-day + 4-week planner swipe horizontally with scroll-snap, 60/108px column widths.
- 4-week planner selected cell now actually pops (saturated fill, 2px border, 3px outer ring, 180ms delay before modal so the highlight is visible, auto-scroll into view).

### Clickable KPI cards
Live click-through filters across: Invoices (AR aging buckets + paid/unpaid), Jobs (Completed/Saved/Cancelled/Archived), Team (role filters), Timesheets (open/closed/manual), Agreements (active/overdue/upcoming). Plus Clients KPI cards that deselect + scroll to the overdue follow-ups list; Recurring Invoice Plans now opens the Recurring tab (segmented control promoted from subtle underline tab).

### Job detail modal rearranged
- Full-width landscape overview at top.
- 2x2 action grid: Client | Invoice / Employees | Work Order.
- Recent Activity full width.
- Notes / Supplies / Bottlenecks collapsed into `<details>` with "🔒 Internal only" pills + a "Not visible to the client" subline.

### Clients page cleanup
- Killed the Client Snapshot / Owner Workflow / Client Summary card set — pure product copy, no live data.
- Removed duplicate Add/Import buttons from the list search bar.
- All Clients / Recurring Invoices promoted from subtle tab link to a proper pill-style segmented control.
- Client detail header: label-style contact block (`PHONE | EMAIL | ADDRESS` each on own line with tappable tel:/mailto:/maps link).
- "Quick Invoice" rewrite: clear explanatory copy, no more mystery file upload guessing.
- 🔗 Invite → 🔗 Send Portal Access with tooltip.

### Team page
- Workflow card deleted (matched Clients page cleanup).
- Team Snapshot gained an **Onboarded on mobile app** row — `✅ N of M` / `🟢 partial` / `⚪ none` based on `employees.push_token`.
- Crew Sign-up Link card fully rewritten to spell out exactly what the link does (roster + job assignment + mobile app access) and what it doesn't (dashboard access — that's per-employee "Grant dashboard access").
- Phone-consistency warnings planted on all crew sign-up surfaces (Add Employee modal, Crew Sign-up Link card, public /join page) with copy emphasizing the phone number is how crew sign into the mobile app and must match what the employer saved.

### Misc polish
- CSV exports: clients + invoices (with tax-time date presets: YTD, Last year, Last quarter, Last 30 days, All time, Custom; status filter All/Paid/Unpaid; summary rows with totals).
- Logo remove button + `DELETE /api/settings/logo`.
- Optional `license_number` field (Settings → Company Info), renders as "Lic. #..." on `/invoice` + `/workorder` when set.
- Voice bot renamed Choppy → AI Assistant on every user-facing surface (kept Choppy for internal MC integration).
- Currency-formatted invoice amount inputs (parse + format with `$50.00` prefix).
- Client dropdown added to New Job form; chip multi-select crew picker (name · phone).
- Recently Closed jobs card on Jobs page (last 7 days, clickable rows).
- Enterprise/Custom Quote CTA in Additional Users section, mailto sales@linkcrew.io with prefilled body.
- Voice bot setup guide at `/voicebot-setup`.
- Settings cleanup: removed duplicate Crew Invite Link card, removed "Forever"/"Keep forever" promises (plan limits language), appointment reminders moved to Schedule header with auto-save, removed lost header action buttons.
- Portal login page: dark gradient replaces stock photo, tenant-branded logo + name when invite token present, "Powered by LinkCrew" footer.
- `/api/me` now returns tenant branding for first-paint on mobile.

## What's still pending

### Immediate / short-term
- **Live Stripe Connect cutover** — swap sandbox env vars to live (sk_live_, live webhook secret, live ca_ client_id from Stripe live Platform Profile), enable Connect events on live webhook endpoint, $1 smoke test.
- **VPS migration** — plan drafted at `deploy/VPS_MIGRATION_PLAN.md`. Domain stays linkcrew.io. ~12-15 hours of work over a week. Recommended BEFORE app build.

### Medium-term
- **Mobile app rebuild (hybrid)** — strip `(owner)` and `(manager)` sections from fieldsync-app, slim to crew-native with WebView owner dashboard. Offline-first via SQLite for field crew (jobs, invoices read, timesheet queued, photos queued for sync). Native login with phone OTP, Universal Links + App Links for `/join`. Architecture filed in memory (`linkcrew_mobile_onboarding.md`).
- **iOS eas credentials** — Apple Developer approved, credentials setup interrupted. Resume with `eas credentials` in fieldsync-app/.

### Parked
- **Grow / Upsell sidebar section** — catalog + rationale saved to memory (`linkcrew_grow_upsell_plan.md`). Revisit post-launch once there's real usage data.

## Sandbox -> Live checklist (Stripe)
1. Stripe dashboard → switch to **Live** mode.
2. Connect → Platform Profile — redo in live mode.
3. Copy live client_id (`ca_...`) → update `STRIPE_CONNECT_CLIENT_ID` on Render.
4. Developers → API keys → copy `sk_live_...` → update `STRIPE_SECRET_KEY` on Render.
5. Developers → Webhooks → create endpoint in live (URL: `https://linkcrew.io/api/stripe/webhook`, events: `checkout.session.completed`, `account.updated`, `account.application.deauthorized`, listen on connected accounts).
6. Copy live webhook signing secret → update `STRIPE_WEBHOOK_SECRET` on Render.
7. Wait for redeploy.
8. Real $1 smoke test on a non-production client with a real card, refund immediately.

## Notes for future sessions
- Phone number is the crew identity. Every crew sign-up surface now warns about this.
- "Choppy" is internal-only — don't add it back to user-facing surfaces.
- Don't restore the LinkCrew logo fallback on invoices (branding decision).
- Don't restore photo retention "Forever" label (legal foot-gun).
- Don't surface any Grow/Upsell section without explicit greenlight.
