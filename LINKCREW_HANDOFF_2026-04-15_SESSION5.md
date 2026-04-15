LinkCrew Handoff
Date: 2026-04-15
Session: 5

Checkpoint
- Branch: `main`
- Scope saved in this checkpoint:
  - `dashboard/index.html`
  - this handoff note only

Summary
- Continued the LinkCrew owner-dashboard redesign and recovery after the earlier crash.
- Restored the Team sidebar subgroup and page-level crew onboarding flow:
  - `Team` now has chevron submenu items:
    - `Crew`
    - `Invite Crew`
    - `Saved Links`
  - crew invite flow now lives on the Team page again instead of being buried in Settings
  - saved dashboard setup links were restored to the Team page
- Restored missing owner-workspace structure that had been flattened during recovery:
  - compact sidebar `Quick Launch`
  - business-nav structure with `Invoices` and `Expenses`
  - invoice worksheet/composer section
  - expenses workspace/composer section
- Fixed quick-launch routing so it no longer dead-ends:
  - `client` opens client add flow
  - `team` opens team add flow
  - `request`, `quote`, `invoice`, and `expense` jump to the right page section

What was verified
- Extracted the inline dashboard script from `dashboard/index.html` and ran `node --check` on it successfully.
- Confirmed the restored structures exist in the file:
  - sidebar quick launch
  - team submenu
  - invoice worksheet section
  - expenses view
  - workspace-section jump helper
- Local browser preview loaded the page shell, but owner-flow verification with real data was not completed because the local preview lands on sign-in without an authenticated session.

Important notes
- There are unrelated local changes in this repo:
  - backend/server files
  - deploy/VPS files
  - package files
  - logo files
- Those should stay out of dashboard-only commits unless explicitly intended.
- `Expenses` is restored as a UI/workflow page, but it is not wired to a live expense backend because no existing expense CRUD/backend path was found in the current codebase.

Next checks
1. Open the real logged-in LinkCrew owner dashboard and verify:
   - Team submenu behavior
   - Team invite and saved-links sections
   - invoice worksheet layout
   - expenses page layout
2. Confirm Quick Launch actions still feel right in-session:
   - New Request
   - New Quote
   - Create Invoice
   - New Expense
   - Add Client
   - Add Team Member
3. Continue hunting pre-crash page regressions using preserved screenshots if anything else looks missing, especially around invoice/expense workflow depth.
