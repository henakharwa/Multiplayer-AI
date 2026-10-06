# Internal acceptance test matrix

Run this checklist against a clean workspace and a workspace with GitHub, Slack, Linear, Notion, and Figma connected. Record the build SHA, tester, result, and evidence for every case.

| Area | Basic case | Edge / failure case | Expected result |
| --- | --- | --- | --- |
| Navigation | Open every primary tab | Narrow viewport and long workspace name | Correct route, distinct icon, no overlap or horizontal clipping |
| Integrations | Connect each provider | Invalid credential, disconnect, multiple connections | Accurate connected status, icon, owner, aligned card and recoverable error |
| Agents | Create, save, publish agent | Blank name, unapproved tool, unpublished agent selected | Validation blocks invalid state; only published compatible agents run |
| Workflows | Create manual and scheduled workflow | Missing instructions, disabled workflow, failed run | Correct trigger, run history, audit event, failure detail |
| Workflow approvals | Propose a write | Decline, double approve, lost integration | One governed action only; authorization and audit trail retained |
| Memory | Save knowledge and decision memory | Empty input, stale freshness date, delete | Clear validation; agent receives only applicable workspace context |
| Artifacts | Create plan, report, dashboard, task list, release notes | Switch setup/compose/review, invalid owner, public share revoke | Step-specific UI and safe persisted artifact data |
| Activity | Filter, search, export CSV, paginate | Empty result, special characters, 10th/11th item | Filters compose, CSV downloads, exactly ten records per page |
| Observability | Filter range and inspect run | Provider omits usage/cost; failed run; no runs | Actual usage displayed when available; explicit estimate fallback and useful empty state |
| Observability alerts | Cause threshold workflow failures | Repeated retry after threshold | One workspace alert at threshold, no alert spam |
| Retention | Set 7/30/90/365-day policy | Expired records, invalid value, server restart | Expired runs removed on save and daily enforcement; invalid values rejected |
| Notifications inbox | Search, filter, group, bulk mark read | No matches, duplicate group, long notification text | Stable grouping, accurate unread count, accessible actions |
| Notifications approvals | Approve or decline from notification | Unauthorized user, resolved action, network failure | Same governed path as chat card; no duplicate action |
| Notifications preferences | Change in-app, escalation, digest settings | Browser refresh, invalid hour, simultaneous saves | Preferences persist per user and invalid values are rejected |
| Notifications escalation | Leave a decision unread past threshold | Read before threshold, repeated scheduler pass | One high-priority reminder only for unresolved decisions |
| Notifications digest | Enable daily digest at selected UTC hour | Disabled digest, second scheduler pass same day | One digest per day, no duplicate |
| Authorization | Repeat admin/editor flows | Direct API request without access | API returns 401/403; no state mutation |
| Accessibility | Keyboard through forms, buttons, dialogs | Screen reader labels and 200% zoom | Visible focus, labeled controls, usable layout |
| Resilience | Restart server during scheduled task | Provider timeout/rate limit | No duplicate schedule claim; clear failure/audit record |

## Automated internal test suite

Each feature has an automated suite that runs against the real Express app and a real PostgreSQL database. Only GitHub, Slack, the LLM and email delivery are faked. Every group has basic (happy path), edge (limits, odd or invalid input) and security (wrong role, outsider, signed out) cases.

Run it with `npm run test:full`, or only the internal cases with `npx vitest run tests/internal` inside `services/chat-server` (needs `DATABASE_URL`).

| ID | Feature | File | Cases | What is covered |
| --- | --- | --- | --- | --- |
| WS-01..06 | Workspaces, join codes, invitations, members | `workspaces.internal.test.ts` | 23 | Create (blank, duplicate per creator, unicode); list; join (idempotent, admin keeps role, guess rate limit only counts failures); invite/accept/revoke, failed email; promote/demote, last-Admin guard, leave; id guard 400/404/403/401 |
| PM-01..04 | Role access matrix and permission requests | `permissions.internal.test.ts` | 15 | Effective access per role; Admin-only endpoints refused for Editors; policy save, unknown keys dropped; createAgents/publishAgents/connectTools gates; request → approve/reject, duplicates, bad input, decided twice |
| CV-01..05 | Conversations, history, activity log | `conversations.internal.test.ts` | 17 | Create/rename/pin/archive/delete, last-conversation recovery, cross-workspace access; message order and conversationId checks; audit filters, pagination, bad `before`, special characters |
| TK-01..02, MM-01 | Tasks and memory | `tasks-memory.internal.test.ts` | 17 | Title limits, owner must be a member, real calendar dates, status columns, clearing owner/due date; shared memory edit/delete, URL scheme and review-date validation, size limits |
| AR-01..06 | Artifacts | `artifacts.internal.test.ts` | 18 | All five types, author-or-Admin rule, versions and restore, comments, presence, generators by type, Slack share without connection, public links (drafts hidden, type-specific, revoked, malformed tokens) |
| AG-01, WF-01, OB-01 | Agents, workflows, observability | `agents-workflows.internal.test.ts` | 20 | Agent name rules, provider filtering, partial updates, numbered publish versions; workflow schedule bounds 5–10080, published-agent rule, requiresApproval kept, manual run recorded, trigger mismatch, bad pagination; retention 7/30/90/365 and alert threshold 1–20 (Admin only) |
| NT-01..02, PF-01, IN-01, SY-01 | Notifications, preferences, integrations, platform | `platform.internal.test.ts` | 20 | Read state, privacy, bad query values, membership; notification preferences (invalid values ignored, per member); member preferences (keys, 20 KB, falsy values); integration test/disconnect validation; health, malformed JSON, wrong JSON shapes, malformed nested ids, forged session |
| WEB-01..02 | Web client helpers | `apps/web/tests/internal-client.test.ts` | 7 | Error messages per status, network failure, fallback; chat-server URL selection in development, production and with explicit settings |

### Latest run

- Internal suite: 130 server cases and 7 web cases, all passing.
- Full regression: chat server 306, database 16, integrations 2, web 12 — all passing. Type checks and the formatting check are clean.

### Defects found by the internal suite and fixed

| ID | Defect | Fix |
| --- | --- | --- |
| WS-03 | Successful joins counted toward the join-code guessing limit, so a user joining many workspaces got 429; the code lookup endpoint had no limit at all | Only failed lookups count; the lookup endpoint shares the same limit |
| TK-01 | Task due dates came back as text like "Tue Dec 01" instead of `2026-12-01` | Dates are formatted as the stored calendar date |
| TK-01 | An impossible date such as 2026-02-31 caused a server error (500) | Dates are checked as real calendar days and return 400 |
| TK-01/02 | Task owner could be someone outside the workspace; owner and due date could not be cleared; new tasks ignored the chosen column | Owner must be a member; null clears; status is saved on create |
| PM-04 | An Editor could file the same pending request many times | Second pending request returns 409 |
| AG-01 | Blank or whitespace-only agent names were accepted | Names are trimmed, required and capped at 80 characters |
| CV-05 | An invalid `before` value in the activity log caused a 500 | Returns 400 |
| SY-01 | Malformed JSON bodies returned 500 | Body-parser errors return their 4xx status |
| SY-01 | Malformed ids in nested routes (tasks, memory, artifacts, agents, workflows, members, invitations, requests, versions) could reach the database and fail | Rejected up front with 404 |
| WF-01, NT-01 | A fractional `limit` such as 1.5 caused a 500 in run history, notifications and audit | Limits are rounded down |
| NT-01/02 | Non-members could read or change notification settings for any workspace id | Membership is required (403) |
| NT-02 | A non-boolean switch value such as "yes" could be saved or cause a 500 | Only real booleans change a switch |
| AR-01, MM-01, WF-01 | No length limits on artifact titles, memory and workflow names | Artifact and memory titles 200, memory content 20,000, workflow names 120 |
| Web | The rename dialog allowed 120 characters but the server only accepts 100 | Dialog limit is now 100 |

## Automated validation

- `npm test` runs package, integration, server, and database tests when `DATABASE_URL` is available.
- `npm run build` type-checks every package and creates the web production build.
- Database-backed tests require a running PostgreSQL instance and migrations before execution.
