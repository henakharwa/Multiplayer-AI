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
| Authorization | Repeat admin/editor/viewer flows | Direct API request without access | API returns 401/403; no state mutation |
| Accessibility | Keyboard through forms, buttons, dialogs | Screen reader labels and 200% zoom | Visible focus, labeled controls, usable layout |
| Resilience | Restart server during scheduled task | Provider timeout/rate limit | No duplicate schedule claim; clear failure/audit record |

## Automated validation

- `npm test` runs package, integration, server, and database tests when `DATABASE_URL` is available.
- `npm run build` type-checks every package and creates the web production build.
- Database-backed tests require a running PostgreSQL instance and migrations before execution.
