# AI Club Member & Event Management Platform

A centralized platform for managing AI Club members, events, attendance, notifications, and analytics, designed to improve engagement and streamline club operations.

**Empowering AI clubs with a modern digital platform for member engagement, event management, and data-driven growth.**

## Capabilities

- Microsoft Entra ID sign-in, automatic member onboarding, and editable profiles.
- Member, Officer, Advisor, and Administrator roles enforced by the API.
- Workshops, hackathons, competitions, mentoring sessions, and other events.
- Transactional registration and cancellation with capacity enforcement under concurrent requests.
- Personal participation history and private QR tickets; staff attendance check-in using scanned ticket tokens.
- In-app notifications, a persistent email queue, and automatic reminders during the 24 hours before an event.
- Leadership reports with event/category/member engagement metrics and CSV export.
- Outlook-compatible calendar downloads; optional Microsoft 365 email and club-calendar synchronization through Microsoft Graph.
- Optional Teams Workflow and Discord webhook announcements.

This is a runnable initial implementation, not an already provisioned Azure service. Microsoft sign-in requires your tenant's app registrations. External delivery requires provider configuration; no credentials, sample accounts, or authentication bypasses are included.

Event cancellation is permanent, keeping attendance history and Outlook state consistent. Create a replacement event if needed. Authenticated dashboards refresh capacity and personal updates every 15 seconds; registration always rechecks availability transactionally.

## Architecture and roles

| Component | Implementation |
| --- | --- |
| Web | Next.js App Router, React, TypeScript, Tailwind CSS |
| API | Node.js, Express, validated JSON, Entra JWT verification |
| Database | PostgreSQL, versioned transactional migrations |
| Notifications | Separate Node worker and PostgreSQL outbox with retries |
| Deployment | Non-root container targets for Azure App Service or Container Apps |

The browser obtains a delegated access token for **this API**, not a Microsoft Graph token. The API checks its signature, tenant, issuer, audience, expiry, object ID, and required scope. Roles come from PostgreSQL, never from browser input or token role claims. SQL queries are parameterized. Event row locks serialize registrations and capacity changes. Tickets are opaque random bearer credentials: keep them private.

| Role | Permissions |
| --- | --- |
| Member | Own profile, discover/register/cancel, own tickets/history/notifications, calendar download |
| Officer | Member permissions plus create/edit/cancel events, check in attendees, view members/reports |
| Advisor | Member permissions plus read members/reports; cannot manage events or check in |
| Administrator | Officer permissions plus role assignment |

## Local setup

Prerequisites: Node.js 22 or later, npm, PostgreSQL 16 or later (or Docker Compose), and an Entra tenant.

1. Run `npm ci` from the repository root.
2. Create a database. For Docker, set a strong local `POSTGRES_PASSWORD` in your shell and run `docker compose up -d postgres`. The database port is bound to loopback only. If a local PostgreSQL instance already uses port 5432, use it or adjust the Compose port.
3. Copy `apps/api/.env.example` to `apps/api/.env` and `apps/web/.env.example` to `apps/web/.env.local`.
4. Set `DATABASE_URL` to your PostgreSQL connection string, including your database user's credentials if needed. The template deliberately contains no password. Set the Entra values described below.
5. Run `npm run db:migrate`.
6. In separate terminals, run `npm run dev:api`, `npm run dev:web`, and `npm run worker`.
7. Open `http://localhost:3000`. The API listens on `http://localhost:4000`; `GET /health` checks database connectivity.

API scripts automatically read `apps/api/.env`. Next.js reads `apps/web/.env.local`. Shell environment variables take precedence. Keep all real environment files out of version control.

### Microsoft Entra ID

Create two **single-tenant** app registrations:

1. **API registration**: expose a delegated scope named `access_as_user` under `api://<API_CLIENT_ID>`. Configure the API to request **v2 access tokens** (`api.requestedAccessTokenVersion: 2` in the manifest). Set `ENTRA_TENANT_ID` to the tenant GUID, `ENTRA_API_AUDIENCE` to the API client GUID, and `ENTRA_REQUIRED_SCOPE=access_as_user`.
2. **SPA registration**: add a **Single-page application** redirect URI of `http://localhost:3000` and your production HTTPS web origin. Add delegated permission for the API's `access_as_user` scope and grant consent according to your tenant policy. Do not create a SPA client secret.
3. Set `NEXT_PUBLIC_ENTRA_CLIENT_ID` to the SPA client GUID, `NEXT_PUBLIC_ENTRA_TENANT_ID` to the tenant GUID, and `NEXT_PUBLIC_ENTRA_API_SCOPE=api://<API_CLIENT_ID>/access_as_user`. `NEXT_PUBLIC_API_URL` is the API origin. Optionally set `NEXT_PUBLIC_ENTRA_REDIRECT_URI` to a registered redirect URI.
4. Before your first login, put the intended administrator's **tenant user object ID** in `ADMIN_OBJECT_IDS` (comma-separated for multiple administrators). Bootstrap assignment only applies when a member is first created. Subsequent role changes require an administrator; normal members cannot promote themselves.
5. Set `WEB_ORIGIN` to the exact web origin. Only that origin is allowed by API CORS. Use HTTPS in production.

Changing public Next.js environment variables requires rebuilding the web app. A missing browser configuration shows setup guidance rather than fake data.

### Microsoft 365, Outlook, Teams, and Discord

The worker must run for external delivery and reminder generation. In-app registration and event-update notifications are stored immediately by the API.

- **Microsoft Graph**: use a separate confidential app registration with application permissions `Mail.Send` and, for shared club-calendar sync, `Calendars.ReadWrite`. Grant tenant administrator consent. Set server-only `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`, and `GRAPH_MAILBOX` (the club mailbox's address or object ID). `ENTRA_TENANT_ID` is shared with the API. Restrict the application's mailbox access using Exchange Online application RBAC/access policies. Store the secret in Azure Key Vault in production. Emails are sent as plain text. The calendar is the configured mailbox's calendar, not each member's personal calendar.
- **Outlook without Graph calendar permissions**: authenticated members can download an `.ics` file per event and import it into Outlook or another calendar. Downloads are snapshots; download again after event changes.
- **Teams**: configure a Teams Workflow accepting an incoming webhook with the posted Adaptive Card envelope, then set `TEAMS_WEBHOOK_URL`. Treat the URL as a secret. Ensure the workflow's allowed callers match this server-to-server integration.
- **Discord**: set an HTTPS `DISCORD_WEBHOOK_URL` from your channel's integration settings. Announcements suppress mentions.

Creating an event queues channel announcements and Outlook synchronization. Event changes/cancellation queue calendar synchronization and registrant notices. Reminders apply to active, unchecked-in registrations in the next 24 hours. Old reminder jobs are suppressed after cancellation, rescheduling, or deregistration.

Unconfigured Graph jobs remain deferred and are retried hourly; in-app notifications and calendar downloads still work. Unconfigured announcement channels are disabled. Failed deliveries use exponential backoff, with at most eight delivery attempts. Inspect `jobs.last_error`, `attempts`, and `completed_at` for operational status. After fixing configuration, an operator may reset a failed job's `attempts` to zero and `available_at` to `now()` in PostgreSQL. Delivery is **at least once**: a crash after a provider accepts a message but before the job is marked complete can duplicate it. Outlook creation uses Graph transaction IDs and persisted event IDs to reduce duplication. No real-provider delivery is possible without your credentials.

## Validation

```sh
npm run lint
npm run build
npm test
```

The API uses Node's built-in test runner. PostgreSQL integration tests require `TEST_DATABASE_URL` pointing to a **dedicated disposable database**, for example:

```sh
TEST_DATABASE_URL='postgresql:///ai_club_test?host=/var/run/postgresql' npm test
```

Never point tests at a production database. Without that variable, database-dependent tests skip explicitly. Tests cover authorization, validation, registration capacity, attendance, reports, and provider adapters. Microsoft/Teams/Discord requests in automated tests use test doubles, not live accounts.

### Manual acceptance walkthrough

1. Sign in as the bootstrap administrator; create a future event with capacity one.
2. Sign in as a member in a separate browser session; register and confirm that the remaining capacity reaches zero. Another member should receive a full-event error.
3. Open the member's participation tab, show the QR ticket, and download the calendar.
4. Within the check-in window (two hours before start through two hours after end), scan the QR code using a trusted scanner and paste its raw token into the staff check-in form. A second check-in must be rejected.
5. Verify participation history and report/export totals. Confirm that an Advisor can read reports but cannot create events, check in members, or assign roles.
6. Edit/cancel an event and verify registrant notifications. Run the worker with provider credentials and verify delivery in the actual mailbox/channels before launch.

## Azure deployment

Provision Azure Database for PostgreSQL Flexible Server, an Azure Container Registry, and separate web/API/worker services in Azure Container Apps (or App Service). The same API image runs the HTTP service, migrations, and worker:

```sh
docker build --target api -t ai-club-api .
docker build --target web -t ai-club-web \
  --build-arg NEXT_PUBLIC_API_URL=https://your-api-host \
  --build-arg NEXT_PUBLIC_ENTRA_TENANT_ID=your-tenant-guid \
  --build-arg NEXT_PUBLIC_ENTRA_CLIENT_ID=your-spa-client-guid \
  --build-arg NEXT_PUBLIC_ENTRA_API_SCOPE=api://your-api-client-guid/access_as_user .
```

- Push images to your registry through your normal deployment pipeline; configure web ingress on port 3000 and API ingress on port 4000.
- Inject API environment values as secret references, not image build arguments. Require PostgreSQL TLS, for example `?sslmode=verify-full` with a trusted server certificate; never disable certificate verification.
- Run `npm run db:migrate` once as a release job using the API image before starting the new API/worker revision. Migrations are versioned and serialized with a database advisory lock.
- Run the worker image with command `npm run worker`, no public ingress, and at least one always-on replica. Set minimum replica counts for the HTTP services as appropriate.
- Set `WEB_ORIGIN`, the public API URL, and Entra production SPA redirects to the exact HTTPS deployment origins. Enforce HTTPS and configure private database networking/firewall access.
- Set `TRUST_PROXY_HOPS` to the exact number of trusted ingress proxies only when every API request must traverse those proxies. The default `0` ignores forwarded IP headers. Verify this for your Azure network topology so rate limiting uses member IPs rather than a shared ingress IP; never blindly trust arbitrary forwarded headers or enable an unrestricted proxy trust setting.
- Use Key Vault/managed secret references, database backups, Azure Monitor, log retention, and restricted operator access. Avoid logging access tokens, ticket tokens, email bodies, or webhook URLs. Validate health, sign-in, registration, real delivery, and backups before admitting members.

Azure resources, tenant registrations, secrets, monitoring alerts, and organizational consent must be provisioned by the deploying club; this repository does not create or access them automatically.

## Systems analysis and delivery

**Business case:** replacing spreadsheets/forms and scattered messages reduces duplicate administration and gives leadership a consistent record of engagement.

**Stakeholders:** members own their profiles and participation; officers plan activities and record attendance; advisors assess outcomes; administrators manage access; campus IT governs identity, tenant permissions, and hosting.

**Feasibility:** the chosen JavaScript stack shares skills between web and API, PostgreSQL provides transactional consistency, and Azure/Entra align with Microsoft 365. Costs depend on hosting/database tiers and mailbox licensing. Tenant consent, data-retention policy, accessibility review, and operational ownership are launch prerequisites.

**Agile delivery:** validate identity/profiles first, then events/capacity, attendance, notifications/integrations, and reporting with stakeholder acceptance at each increment. The manual walkthrough above supplies initial acceptance scenarios. Future increments can add camera scanning, waitlists, recurring events, richer charts, audit trails, automated retention, and institution-specific consent workflows.
