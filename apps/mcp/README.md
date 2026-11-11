# Application onboarding over MCP

## Advanced detection and monitor preferences

The authenticated agent can use the same advanced settings as the dashboard:

- `get_detection_settings`: read current and recommended detection thresholds.
- `update_detection_settings`: pass only the requested fields in `changes`;
  unspecified preferences are preserved.
- `reset_detection_settings`: restore recommended detection thresholds.
- `list_monitor_alert_settings`: discover existing service/endpoint monitors and
  their reporting preferences without returning health URLs or secrets.
- `update_monitor_alert_settings`: change reporting, failure/recovery thresholds
  or `latencyWarningMs` (`null` disables slow warnings) on an existing manual monitor.

Project-owner authorization and server validation still apply. These tools do
not expose handoff credentials, change notification destinations, enable scheduled
HTTP checks or create monitors. Updating a monitor's alert rules resets its check
streaks, as it does in the dashboard. Restart an existing MCP connection after
updating the server to discover the new tools.

The CLI and MCP are clients of the Everock API. The SDK posts telemetry directly
to its collector routes; agent login does not remove the need to host that API,
its PostgreSQL database or the Redis-backed worker queue.

`get_event_original` retrieves the original accepted event by its stable event ID
from evidence. The API validates the canonical block checksum and project access
before returning the data. Existing evidence queries still return full payloads;
the small analytics projection is never substituted for investigation evidence.

Home recommends agent setup and keeps a manual SDK alternative. The same setup
can be reopened from the Home app actions menu or the command menu.

The agent lists applications first, reuses the matching checkout, or calls
`create_project_component`. It calls `link_component_checkout` to link local repository identity without uploading
source files or requesting GitHub permissions, retrieves
public SDK configuration with `get_component_setup`, publish an architecture
summary, and verify telemetry after the running application emits an event.

Local linking needs only the existing Everock session. The CLI equivalent is
`everock link --project-id <id> --component <component>` from the application
directory. It records the Git origin, branch, runtime and relative directory; it
does not upload local files or a logo. Repeated identical linking is idempotent.

GitHub integration uses `connect_component_repository`. Omit `installationId` to
find an already authorized installation automatically. The CLI attempts the same
connection after `everock link`; use `--local-only` to keep identity-only linking.
When access is missing, `get_component_connection_links` returns the GitHub App
installation URL. The user must grant GitHub access once; Everock login cannot
create permissions in GitHub. Subsequent linking runs from the agent without
visiting the dashboard. Server-side repository reads become possible after this
connection.

## GitHub App activation

Create a GitHub App with Contents read, Metadata read, and a `push` subscription.
Set its webhook URL to `<public API URL>/github/webhook` and configure the same
high-entropy webhook secret as `GITHUB_WEBHOOK_SECRET` in the API environment.
Set `GITHUB_APP_ID`, `GITHUB_APP_SLUG` and `GITHUB_APP_PRIVATE_KEY_PATH` for the API
and worker, then install the app on the selected repositories. The private key
must remain outside source control. The existing PR editing features additionally
require Contents and Pull requests write permissions; do not grant these for
read-only onboarding.

Signed pushes record branch/commit activity per application and mark its default
branch for synchronization. The existing periodic worker performs architecture
synchronization when its analysis credentials are configured. A push alone does
not create a release or deploy an application; deployments remain provider/SDK
reported. This integration does not provide Vercel hosting/build infrastructure.

`get_component_deployment_setup` supplies component-scoped release webhooks.
Webhook URLs are credentials; they must not appear in public logs. This is
deployment reporting, not Cloudflare or Vercel account OAuth.

## Remote connection

The HTTP server needs `SUPABASE_URL`, Supabase OAuth support and
`EVEROCK_API_TOKEN`. Set `MCP_PUBLIC_URL` to its public origin and
`NEXT_PUBLIC_EVEROCK_MCP_URL` in the web app to its `/mcp` endpoint.
Without the public web setting, Home links to the existing personal-key agent
connection guide rather than advertising an unconfigured OAuth endpoint.
The stdio server continues to use the existing personal API key authentication.

## Validation

Run `pnpm --filter @everock/mcp test` with the local database, Redis and root
environment configured. The integration test exercises tools through the MCP
protocol against the real API and isolated database fixtures.

Local activation binds each installation to its Everock account through
`GITHUB_INSTALLATION_OWNERS` (a JSON object of installation ID to email).
Unbound accounts cannot list or connect that installation. A public onboarding
flow still needs verified GitHub user OAuth and persisted installation ownership;
never trust an installation ID supplied by a redirect or expose App-wide
installation lists to arbitrary accounts.

## Shared CLI session

Run `everock login` once. The local stdio MCP automatically reads the resulting
session from `~/.everock/config.json`; no API key needs to be copied into the
agent configuration. `EVEROCK_API_KEY` remains an explicit override for CI.
`everock logout` revokes this session. See
[agent onboarding](../../docs/agent-cli-onboarding.md) for GitHub authorization,
project creation, local commands and deployment requirements.

`get_telemetry_usage` reads the owner account monthly accepted-event/byte/replay counters, protective quotas and UTC reset time. It aggregates projects and cannot change prices, billing or limits.
