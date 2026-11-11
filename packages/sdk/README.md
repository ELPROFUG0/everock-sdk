# @everock/sdk

Browser SDK that ships errors and telemetry to an Everock **surface**.

```ts
import { init, identify, capture, captureError } from '@everock/sdk';

init({
  publicKey: 'pk_YOUR_PROJECT_KEY',      // Keys tab → Public key (safe to expose)
  endpoint: 'https://collector.everock.example',
  environment: 'production',
  release: 'rel_19b94efe85fc3eac',  // usually your build's git sha
  sessionReplay: {
    enabled: true,
    sampleRate: 1,       // lower this in high-traffic production apps
    bufferMs: 60_000,    // context retained before an error
    postErrorMs: 20_000, // context retained after an error
    maskAllInputs: true,
  },
});

// After login, tell the SDK who this is so problems report impacted users:
identify(user.id); // identify(null) on logout

// Uncaught errors and unhandled rejections are captured automatically.
// Record your own events too:
capture('log', 'Checkout completed', { orderId });

// A caught failure is retained as evidence, but does not page by default:
captureError(error, { handled: true, operation: 'checkout' });

// Framework adapters use handled:false for failures that escaped the request:
captureError(error, {
  handled: false,
  mechanism: 'framework_error',
  operation: '/api/checkout',
});
```

## How it works

- Hooks `window.onerror` and `unhandledrejection`.
- Tags every event with a per-tab session id, plus the user id from `identify()`.
- Batches events and POSTs them to `${endpoint}/ingest`, authenticated by the
  surface public key (`x-everock-key`).
- Flushes every 5s, on `maxBatch`, and on page hide (`sendBeacon`, so events
  survive navigation/unload).
- No-op during SSR and when `enabled: false`.
- Records failed network calls and HTTP 5xx responses as anomalies for
  correlation; one isolated response does not automatically become a problem.

## Signal classification

Every captured failure carries a versioned mechanism, runtime source, handled
state and level. Production and staging unhandled failures become problems.
Development/test failures, handled exceptions and expected failures remain
searchable evidence. Dependency, network and HTTP failures start as anomalies.
Five occurrences affecting multiple sessions or users within five minutes
promote them to a problem. Server and worker failures without identities
promote after ten occurrences, so one transient request does not page the team.

Older SDK events remain compatible and are conservatively interpreted as
unhandled failures because they did not include the signal metadata.

## Error session replay

Session replay is opt-in. When enabled, the SDK keeps a short in-memory rrweb
buffer and only uploads it after an error is captured. It then records the
configured post-error window and uploads ordered chunks to private
server-side storage. Query strings and URL fragments are removed before upload,
input values are masked by default, and canvas, cross-origin iframes, inline
images, and fonts are not recorded.

Use these attributes (or their equivalent classes) for application-specific
privacy controls:

```html
<section data-everock-block>Never record this subtree</section>
<span data-everock-mask>Replace this text with masks</span>
<div data-everock-ignore>Ignore mutations in this subtree</div>
```

Replay uploads require the API to have `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` configured. The service-role key belongs only on the
API server; never place it in browser code. Recordings expire after seven days
by default (`REPLAY_RETENTION_DAYS`) and are shown in an incident's Sessions tab
when their session id matches an event for that incident.

The endpoint validates the key, writes rows to the `events` table, and the
surface Dashboard rolls them into 10-minute buckets.

## Multiple repositories in one project

Projects → Add project asks only for a name. It opens agent setup or manual
installation; manual setup selects Browser, Node.js or Edge rather than a
framework. New projects have no declared stack. The agent records the detected
framework and runtime from the checkout, and telemetry confirms the connection.

Home → Add app or service recommends **Set up with my agent**, with manual setup
as an alternative. The MCP tools let the agent inspect the checkout, reuse or
create an application, install its SDK, publish its architecture and connect an
authorized GitHub repository and optional monorepo folder. Repository authorization
stays in the browser. Setup confirms telemetry only after an event arrives.
Use Home → More app actions → Show install instructions to reopen setup, or the
Source row to change the connected repository. Settings → Integrations
keeps the advanced repository, branch and directory controls for each component. For a
monorepo, use the same repository with separate relative directories, such as
`apps/web` and `apps/api`. GitHub App access is required to connect repositories;
a repository detected locally does not grant GitHub access.

Install the SDK in each runtime using the same project's public key and API
endpoint. Set its registered component ID in `init` (supported by the browser,
Node and edge SDKs):

```ts
init({
  publicKey: 'pk_<projectId>',
  endpoint: 'https://your-api.example.com',
  component: 'api',
  serviceName: 'Payments API',
  environment: 'production',
  release: 'your-git-sha',
});
```

Omitting `component` keeps the existing `main` behavior. Unknown IDs are rejected
by ingestion, so create the component first. Identical errors from separate
components create separate problems. Agents can call `list_project_components`
over MCP and use `meta.component` on an incident to find its repository, branch
and directory. Codebase combines the latest map for each component; it does not
invent calls between repositories or provide distributed tracing.

Set `EVEROCK_COMPONENT=api` in the component's build environment when running
`npx @everock/sdk release` or the sourcemap upload command. This keeps releases
and source maps independent even when components use the same release name.
For deploy webhooks, append `component=api` to the webhook query string (preserve
any existing provider query parameter).

For agent-generated architecture scans, link each checkout with
`everock link --project-id <uuid> --component api`, then run `everock scan`.
The component must already exist. Automatic source analysis requires the server's
GitHub App and analyzer configuration; saving the component alone does not
activate those credentials. Managed container push/deploy commands continue to
apply to `main`; deploy other runtimes with their existing provider.

### API endpoints and request health

The Node SDK now observes incoming Node HTTP/HTTPS requests after `init()`:
response codes, duration, timeouts and aborted connections. It also measures
outgoing fetch/HTTP requests. Telemetry identifies `component` and request
`direction`, and does not collect request/response bodies, headers or URL query
parameters. Initialize once at process startup before serving requests.

```ts
import { init, requestHandler, registerEndpoints } from '@everock/sdk/node';
init({ publicKey: 'pk_…', endpoint: 'https://YOUR_COLLECTOR', component: 'api' });
// Optional Express/Nest middleware enriches measurements with route templates.
app.use(requestHandler());
// Declare the full current route catalog once at startup, including idle routes.
registerEndpoints([
  { method: 'POST', path: '/api/scrape/:network', host: 'api.example.com' },
  { method: 'GET', path: '/health', host: 'api.example.com' },
]);
```

Use route templates instead of customer names, tokens or IDs in paths. Automatic
Node capture deduplicates the optional middleware and Fetch handler wrapper.
`captureRequests: false` disables automatic Node request observation;
`requestTimeoutMs` defaults to 30 seconds and should reflect your application's
actual request deadline (for example, longer-running scraping jobs).

For Next.js Fetch route handlers, `withRequest(handler, {route:'/api/:id'})`
provides the same measurement contract. For Workers/Hono/other Edge Fetch apps,
initialize `@everock/sdk/edge` and export a wrapped handler:

```ts
import { init, withRequest, registerEndpoints } from '@everock/sdk/edge';
init({ publicKey: 'pk_…', endpoint: 'https://YOUR_COLLECTOR', component: 'api' });
registerEndpoints([{ method: 'POST', path: '/api/scrape', host: 'api.example.com' }]);
export default { fetch: withRequest((request, env, ctx) => app.fetch(request, env, ctx)) };
```

Pass the Worker's execution context so background delivery uses `waitUntil`.
Telemetry does not wait for the collector before returning the application's
response. Set environment and release to the real deployed values.

Home → Endpoints separates incoming and outgoing calls and allows filtering by
component. Health uses a rolling five-minute window: all server/network failures
means Failing; partial or client errors means Degraded; recent error-free requests
means Healthy. Old traffic becomes No recent traffic, never a presumed outage.
Client aborts do not alone classify the API as a server failure. A route catalog
without measurements shows Not observed in the selected period.

For availability when there are no users, add a **manual API service** with a
safe GET health URL in System → Health. Checks are off until explicitly enabled. Choose an interval from 1 minute to
24 hours (5 minutes suggested), or pause a monitor in its expanded Health row.
The worker schedules due checks on a 10-second sweep, with bounded concurrency
and at most 200 checks per sweep. Checks can start one sweep later, plus queue
and capacity delay. Only manually configured, enabled URLs are probed;
auto-discovered SDK services stay passive. Checks use GET, accept 2xx responses,
do not follow redirects and time out after 8 seconds. An exact host/path GET
endpoint match displays the result in Endpoints. Freshness follows the configured
interval; stale or paused checks do not assert current availability. Do not
probe POST/mutating or paid scraping endpoints automatically. Installing the SDK
observes real traffic; the route catalog declares known endpoints; availability
checks are a separate explicitly configured signal.


Configure an endpoint monitor directly from **Home → Endpoints → Set up monitor**
(or **View all**). Select its health URL, schedule and enabled state; settings are
scoped to the project, component, direction, endpoint identity and selected
environment (All environments is a shared scope). No scheduled call is made
until enabled. For paid or mutating operations, associate a separate safe GET
health URL; never copy a POST operation into the monitor. The UI displays
request health and service availability separately: a successful `/health`
response does not prove that scraping or other endpoint logic works. Configured
endpoints remain listed when their request measurements fall outside the period.
The preview table can open the configuration but cannot persist mock endpoints.

### Problems, warnings and recovery

Endpoint and service monitors show **Report outages in Inbox** and an optional
**Also report slow responses** switch, with the slow threshold in seconds.
**Advanced settings** holds failure/recovery counts and a reset to recommended
thresholds. Alert preferences remain separate from enabling scheduled checks.
By default, three consecutive failed checks open an
Inbox problem; repeats update that episode. An optional latency threshold opens
a warning after the same number of consecutive slow checks. Two consecutive
healthy checks move the problem into verification. Resolution requires at least
15 minutes of verification and fresh positive evidence. A failing or slow check
during verification immediately reopens the episode. Paused, stale or silent
monitors never count as recovery. Disabling alerts leaves check history intact.

**Settings → Detection** shows recommended protection without requiring setup.
Its optional **Advanced settings** configures the SDK error
window, minimum errors, affected sessions/users and optional HTTP volume/error
percentage gates. Defaults are five errors affecting two identities within five
minutes, or ten errors without identities. Unhandled exceptions still open
problems immediately. Request gates apply to correlated HTTP failures, not
unrelated database dependency errors. SDK verification requires fresh successful
traffic in the same component/environment and, for request problems, endpoint.

New SDK problems are grouped by environment, component, mechanism and normalized
request identity (direction, host, method and route). This prevents unrelated
routes or environments sharing a problem. Historical fingerprints are preserved;
new grouping does not rewrite old incidents or correlate root causes across
different sensors automatically.

Lifecycle changes are persisted atomically with the incident, shown as facts in
Activity and exposed in notifications. A durable outbox is drained every five
seconds; configured webhook/GitHub handoffs retry up to five delivery attempts.
Webhook payloads and `x-everock-event-id` contain a stable transition ID so the
receiver can deduplicate retries. Delivery is at least once, and exhaustion of
the retry budget leaves a failed queue job for operational handling. Slack/email
also require their existing notification configuration. MCP access lets an agent
read evidence; waking it automatically requires a configured webhook or CI
receiver. Everock does not run an internal AI diagnosis or automatic code fix.

## Delivery, privacy and visitor consent

### Durable evidence on the collector

Accepted telemetry now commits the event index and canonical evidence in one
PostgreSQL transaction. Canonical blocks use native lossless LZ4/TOAST compression
and a SHA-256 digest over a stable JSON representation. The HTTP success response
is sent after commit; a failed archive write rolls back the index too.
Duplicate SDK IDs create neither another index entry nor another original.

`event_index` contains compact query projections. The read-only `events` SQL
view reconstructs full payloads, so existing evidence, sessions and logs retain
their detail. Home shares one materialized source for its five analytical
outputs and retains exact distinct counts and percentiles. No sampling,
summarization or averaging of percentiles is introduced.

Owners/readers can retrieve an original with
`GET /v1/projects/:id/events/:eventId/original`; the collector verifies the entire
block checksum before returning it. Evidence now includes stable event IDs.
The MCP equivalent is `get_event_original`.

Apply `packages/db/migrations/20261107_event_archives.sql` after the earlier event
migrations and before starting this server/worker version. It requires PostgreSQL
with LZ4 support (the local PostgreSQL 16 image supports it). It renames the physical
table and creates the compatibility view; do not recreate it with `db:push` or
keep an old ingestion process running during this migration.

The worker archives older rows in bounded batches. Older records preserve the
data originally stored; migration cannot reconstruct envelope fields that the
previous collector never saved. `rebuildEventIndex` can restore missing index
rows in paginated, idempotent batches using checksum-verified archive metadata.
Archives do not expire implicitly. Cleanup removes only explicitly expired blocks
with no live index references; losing an index alone never deletes its original.
Project deletion cascades through both stores. Event retention policies must
expire both the index and its canonical blocks deliberately.

This is durable collector storage, not a persistent offline queue in the SDK.
The client-side bounded delivery limits described below still apply. Backups,
replication and off-site object-storage archival remain deployment concerns.

Browser, Node and Edge capture share a bounded transport: HTTP 408/429/5xx and
network failures retry up to three attempts, with exponential backoff, jitter,
`Retry-After` and a ten-second delivery budget. Failed recoverable batches stay
in the bounded queue and pending-event journal for a later flush. Non-retryable 4xx are discarded;
401/403/404/410 stop subsequent network attempts until SDK initialization resets
that transport. Event batches are limited by UTF-8 bytes as well as count.
`sendBeacon` uses JSON content type, including the public key in its body.
Acceptance by the browser's beacon queue is not confirmation from the server.
Each new SDK event receives a UUID before buffering. The collector deduplicates
these IDs per project, including concurrent retries, before updating incidents.
No-response signals omit an HTTP status rather than reporting an invalid zero;
HTTP request measurements can still use zero to represent no response.
There is no persistent offline queue or exactly-once delivery guarantee; abrupt
termination and a full queue can lose events. Legacy events without IDs and
service-only or partially replayed aggregate batches can still duplicate counts.

`getDiagnostics()` (browser, Node and Edge entry points) returns delivery
attempts, failed requests, last status/success/failure, retry time, circuit state,
queued event count and in-flight state without exposing credentials or payloads.

All runtimes redact common credential fields and remove credentials, queries
and fragments from HTTP URLs in telemetry before buffering. Payloads are copied
without invoking getters/toJSON, cycles and bigint are safe, and application
objects are never modified. `beforeSend` can filter normal telemetry events;
returning null or throwing discards that event. Replay uses DOM masking and URL
redaction separately; it does not pass through `beforeSend`. Path segments and
arbitrary free text can contain personal information: use route templates,
`redactKeys`, `beforeSend`, and DOM block/mask attributes for your application.

```ts
import {init, setConsent, getConsent} from '@everock/sdk';
init({
  publicKey: 'pk_…',
  endpoint: 'https://your-collector.example',
  consent: {analytics: false, replay: false},
  sessionReplay: {enabled: true, maskAllInputs: true, maskAllText: true},
  redactKeys: ['customerEmail'],
  beforeSend(event) {
    if (event.message === 'ignore this event') return null;
    return event;
  },
});
// Call from your consent manager after the visitor chooses.
setConsent({analytics: true, replay: true});
// Revoking analytics also aborts event uploads, clears pending data/identities,
// stops browser sensors, and discards replay buffers/queued uploads.
setConsent({analytics: false, replay: false});
```

Supplying `consent` defaults omitted categories to false. Omitting it preserves
existing capture behavior. No session/device IDs or remote configuration calls
are started while analytics consent is false. Dashboard toggles can never
override visitor consent, and explicit `sessionReplay: false` cannot be enabled
remotely. Revocation cannot retract data already accepted by the server.
Re-enabling consent does not replay captured events from the denied period.
Next and Vite client integrations also export `setConsent` and `getConsent`.

## Request correlation and shutdown

Events include W3C-compatible `traceId`, `spanId`, `parentSpanId` and `traceFlags`
in their payload. Browser fetch/XHR calls propagate `traceparent` to the current
origin and to explicitly allowed origins. Node incoming requests extract it;
AsyncLocalStorage isolates concurrent requests and retains context across await.
Node outbound fetch/http/https propagate only to allowed origins. Existing
application headers are respected; no baggage or authorization is collected.

```ts
import {init, withRequest, withSpan, flush, shutdown} from '@everock/sdk/node';
init({publicKey: 'pk_…', tracePropagationTargets: ['https://api.example.com']});
const handler = withRequest(async request => {
  return withSpan('lookup', async () => new Response('ok'));
}, {route: '/api/items/:id'});
await flush();    // Wait for the current bounded delivery attempt.
await shutdown(); // Flush pending work before ending the process/invocation.
```

The default instrumentation uses native W3C correlation. The optional
OpenTelemetry exporter below can also receive third-party OTel spans; the SDK
does not register or replace a global OTel provider. Browser traces are rooted in
the current page; there is no promise-context patching or guaranteed click-to-
async-operation parentage. Edge incoming spans are request-local; outbound Edge
calls do not implicitly inherit an incoming request context. Browsers must allow
the `traceparent` header in CORS for configured cross-origin targets. Existing
HTTP, database service discovery and error classification remain enabled.

The browser also observes XHR timings, document load and new long tasks when
`capturePerformance` is enabled and consent permits it. Its performance sensors
unsubscribe on shutdown or consent revocation.

## Build integrations

Vite's existing `everock()` plugin and Next's `withEverock(config, options)`
now report releases and upload emitted client sourcemaps after compilation.
They use `EVEROCK_RELEASE`, a provider commit SHA, or the checkout commit.
The public release/component tags match the upload. `EVEROCK_API_KEY` (or the
build-only `apiKey` option) authorizes source-map uploads; it is never added to
client defines. Source maps may contain original source code: configure upload
only for builds whose source you intend to send to your Everock server.

Vite defaults to hidden maps. Next requires a version with
`compiler.runAfterProductionCompile` (verified with Next 15.5); setting up map
upload enables its production browser maps. Next's emitted maps can be publicly
served depending on your hosting configuration. Uploads are sequential batches
of at most 100 files / 24 MiB, support .js/.mjs/.cjs maps, validate server receipts,
ignore symlinks and retain local maps. A telemetry upload failure never fails the
application build. Existing compiler hooks run first; failed Vite builds do not
report a completed release. Disable with `reportRelease: false` or
`uploadSourceMaps: false`. Standalone CLI upload remains supported.

Next server integrations export `withServerAction`, which preserves thrown
errors and excludes redirect/notFound control flow from error capture. Use
`withServerAction(action, {after})` with Next's `after` to flush after the response;
without it the wrapper awaits a bounded flush. `flushAfterResponse(after)` is
also available for other serverless code. Nest's module awaits SDK shutdown in
its application shutdown hook (enable Nest shutdown hooks for process signals).


## Optional OpenTelemetry exporter

`@everock/sdk/opentelemetry` exports `EverockSpanExporter`, compatible with
OpenTelemetry's `SpanExporter` contract and independent of the provider version.
A real-provider smoke test passed against sdk-trace-base 2.12 / API 1.9 and
sdk-trace 3.1 / API 1.10. For the current 3.x API:

```ts
import {TracerProvider, BatchSpanProcessor} from '@opentelemetry/sdk-trace';
import {EverockSpanExporter} from '@everock/sdk/opentelemetry';
const exporter = new EverockSpanExporter({
  publicKey: 'pk_…', endpoint: 'https://your-collector.example',
  component: 'api', serviceName: 'Payments API', release: 'your-build-sha',
});
const provider = new TracerProvider({
  spanProcessors: [new BatchSpanProcessor({exporter})],
});
// Register/use this provider through your application's normal OTel setup.
// For OTel 2.x use new BatchSpanProcessor(exporter) instead.
await provider.forceFlush();
await provider.shutdown();
```

Spans keep their original trace/parent IDs, timing, status, attributes and events.
They use the same redaction, filter, byte limits and retry transport. Collector
spans are ignored to prevent an export loop. Export failures are reported via
OTel's callback; forceFlush/shutdown reject if pending spans cannot be delivered.
Spans appear as `payload.kind = 'span'` trace events, preserving existing HTTP
metrics. OTel provider registration, context managers, samplers and third-party
instrumentation remain controlled by the host app. In browsers, gate this
optional exporter with the visitor's consent (for example via `beforeSend`).


## Beta delivery journal and diagnostics

Browser and Node entries now journal **sanitized ordinary events** before flushing: IndexedDB after analytics consent, or private Node files (directory 0700/files 0600). By default Node keeps up to 10,000 events or 24 MB, and the browser keeps up to 1,000 events or 5 MB. Both expire entries after 24 hours. Expiry is enforced when the SDK runs; this is not an OS background erasure service. Filesystem writes are atomic and synced; persistence runs asynchronously, so an event captured immediately before a forced process kill can still be lost before its write completes. Browser storage can be unavailable, evicted or cleared by the browser. Session replay remains a separate opt-in, in-memory capture flow and is not stored in this journal.

```ts
init({
  publicKey: 'pk_<random project key>',
  endpoint: 'https://your-fixed-collector',
  persistence: {maxEvents: 1000, maxBytes: 5_000_000, maxAgeMs: 86_400_000},
});
```

Set `persistence:false` to disable it, or supply `{store}` implementing `load`, `apply(put, remove)` and `clear`. Node also accepts a private `directory`. Edge/Cloudflare has no assumed durable filesystem: supply a durable adapter explicitly; await `flush()` / use the handler's `waitUntil`. The journal is scoped to collector/key/component and preserves UUIDs across recovery so the server deduplicates retries. Only an HTTP acknowledgment removes persisted data; sendBeacon merely queues a browser request and does not count as a server acknowledgment. Revoking browser analytics clears its journal and cancels outstanding delivery; re-enabling waits for that erasure. Dashboard plugin revocation also removes its queued plugin events.

`getDiagnostics()` exposes delivery failures/status, retry time, memory pressure, local filter/size/serialization reasons, and persistence recovery/capacity/expiry/storage-error counters. Counts contain no event contents, keys, user IDs or collector URLs. Storage failure falls back to bounded in-memory delivery; check `storageErrors`, rather than assuming an event is durable. `pendingDurableEvents` means events tracked by the journal; inspect the error counter to know whether the store confirmed its writes. Buffers intentionally drop oldest events under sustained pressure; this is never a claim of lossless delivery through an unlimited outage.

The API now rejects predictable `pk_<project UUID>` credentials. Obtain the random public key through project setup / CLI; these keys can be rotated/revoked. Do not substitute a project ID when key loading fails. Monthly account quotas survive project deletion and key rotation. Ingestion/replay limits return 429 with Retry-After; collector/Redis outages return retryable 503.

`node packages/sdk/scripts/pack-local.mjs <destination> [version]` creates a versioned tarball containing compiled ESM JavaScript and declarations, with no workspace dependencies or TS runtime loader required. CI builds and tests this package in plain Node, workerd, Chrome, Firefox and WebKit. The tarball is a reviewable release artifact; creating it does not publish to npm.
