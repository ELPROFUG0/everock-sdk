/**
 * Everock MCP tool registry shared by the local stdio and remote HTTP
 * transports.
 *
 * Runs on the developer's machine next to their coding agent (Claude Code,
 * Codex, Cursor, …). It exposes the Everock platform as tools so the local
 * agent can monitor a cloud project in real time and act on it — read logs,
 * metrics and deployments, then restart / roll back / (un)publish — without
 * leaving the chat.
 *
 * Auth:
 * - stdio uses a personal API key (ak_…)
 * - remote HTTP receives a validated OAuth identity through MCP AuthInfo
 *
 *   env EVEROCK_API_KEY   required, "ak_…"
 *   env EVEROCK_API_URL   defaults to http://localhost:4000
 */
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {registerComponentTools} from './component-tools.js';
import {registerAlertTools} from './alert-tools.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';

function cliSession():{apiKey?:string;apiUrl?:string}{try{return JSON.parse(readFileSync(join(process.env.EVEROCK_CONFIG_DIR??join(homedir(),'.everock'),'config.json'),'utf8'));}catch{return {};}}
export const apiOrigin=()=> (process.env.EVEROCK_API_URL ?? cliSession().apiUrl ?? 'http://localhost:4000').replace(/\/$/, '');
const API_KEY = process.env.EVEROCK_API_KEY ?? '';
const API_TOKEN = process.env.EVEROCK_API_TOKEN ?? '';
type AgentKind = 'codex' | 'claude';
const envAgentKind =
  process.env.EVEROCK_AGENT_KIND === 'codex' || process.env.EVEROCK_AGENT_KIND === 'claude'
    ? process.env.EVEROCK_AGENT_KIND
    : undefined;
const requestIdentity = new AsyncLocalStorage<{ email?: string; agentKind?: AgentKind }>();

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const ok = (data: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
});
const fail = (msg: string): ToolResult => ({
  content: [{ type: 'text', text: `Error: ${msg}` }],
  isError: true,
});

async function call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const email = requestIdentity.getStore()?.email;
  const bearer = email ? API_TOKEN : API_KEY || cliSession().apiKey;
  if (!bearer) {
    throw new Error(
      email
        ? 'EVEROCK_API_TOKEN is required by the remote MCP server.'
        : 'Run everock login first, or set EVEROCK_API_KEY for CI.',
    );
  }
  const res = await fetch(`${apiOrigin()}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(email ? { 'x-user-email': email } : {}),
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const detail = (data && (data.error as string)) || res.statusText;
    throw new Error(`${res.status} ${detail}`);
  }
  return data as T;
}

type IncidentEnvelope = {
  incident: {
    assignees?: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

async function ensureAgentAssigned(
  projectId: string,
  incidentId: string,
  current?: IncidentEnvelope,
): Promise<IncidentEnvelope> {
  const agentKind = requestIdentity.getStore()?.agentKind;
  const base = `/v1/projects/${projectId}/incidents/${incidentId}`;
  const incident = current ?? (await call<IncidentEnvelope>(base));
  if (!agentKind) return incident;

  const principal = `agent:${agentKind}`;
  const assignees = incident.incident.assignees ?? [];
  if (assignees.includes(principal)) return incident;

  return call<IncidentEnvelope>(base, {
    method: 'PATCH',
    body: { assignees: [...assignees, principal] },
  });
}

function activeAgentName(): string {
  const agentKind = requestIdentity.getStore()?.agentKind;
  if (agentKind === 'codex') return 'Codex';
  if (agentKind === 'claude') return 'Claude';
  return 'Coding agent';
}

type IncidentProgressPhase = 'analyzing' | 'proposing' | 'correcting';
type IncidentProgressStatus = 'active' | 'completed' | 'failed';

async function updateIncidentProgress(
  projectId: string,
  incidentId: string,
  phase: IncidentProgressPhase,
  status: IncidentProgressStatus,
  detail?: string,
): Promise<void> {
  await call(`/v1/projects/${projectId}/incidents/${incidentId}/progress`, {
    method: 'POST',
    body: {
      phase,
      status,
      actor: activeAgentName(),
      ...(detail ? { detail } : {}),
    },
  });
}

/** Wrap a handler so thrown errors become MCP error results, not crashes. */
const tool =
  (fn: (args: any) => Promise<ToolResult>) =>
  async (args: any, extra?: { authInfo?: AuthInfo }): Promise<ToolResult> => {
    const email =
      typeof extra?.authInfo?.extra?.email === 'string' ? extra.authInfo.extra.email : undefined;
    const rawAgentKind = extra?.authInfo?.extra?.agentKind;
    const agentKind =
      rawAgentKind === 'codex' || rawAgentKind === 'claude' ? rawAgentKind : envAgentKind;
    return requestIdentity.run({ email, agentKind }, async () => {
      try {
        return await fn(args);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    });
  };

const pid = { projectId: z.string().uuid().describe('The project id (from list_projects).') };

export function createServer() {
const server = new McpServer({ name: 'everock', version: '0.1.0' });

// ── read: discovery ──
server.tool(
  'list_projects',
  'List your Everock projects (id, slug, status, mode, custom domain).',
  {},
  tool(async () => ok(await call('/v1/projects'))),
);

server.tool(
  'list_project_components',
  'List Web, API and worker components in a project, with repository, branch, monorepo directory and latest analyzed commit. Use the incident meta.component to select the correct source repository.',
  pid,
  tool(async ({ projectId }) => ok(await call(`/v1/projects/${projectId}/components`))),
);

registerComponentTools(server,call,tool,apiOrigin);
registerAlertTools(server,call,tool);
server.tool('get_telemetry_usage','Read the owner account monthly telemetry counters, protective limits and UTC reset time. Quotas aggregate all projects and survive project deletion/key rotation. This tool does not change billing or quotas.',pid,tool(async({projectId})=>ok(await call(`/v1/projects/${projectId}/usage`))));

server.tool('get_event_original','Read original accepted telemetry for an event, with canonical archive checksum verification. Use an event ID from evidence; this is a read-only operation and respects project access.',{...pid,eventId:z.string().uuid()},tool(async({projectId,eventId})=>ok(await call(`/v1/projects/${projectId}/events/${eventId}/original`))));

// ── read: observability ──
server.tool(
  'get_requests',
  'Recent HTTP request logs for a project (Vercel-style). Use level="error" to see only 4xx/5xx, q to search paths, period like 30m/1h/12h/1d/3d/1w/2w.',
  {
    ...pid,
    level: z.enum(['all', 'error']).optional(),
    q: z.string().optional(),
    period: z.string().optional(),
  },
  tool(async ({ projectId, level, q, period }) => {
    const p = new URLSearchParams({ projectId });
    if (level && level !== 'all') p.set('level', level);
    if (q) p.set('q', q);
    if (period) p.set('period', period);
    return ok(await call(`/v1/logs/requests?${p.toString()}`));
  }),
);

server.tool(
  'get_events',
  'Lifecycle & error events for a project (create/wake/sleep/publish/rollback/error). This is where build/deploy and crash diagnostics show up.',
  { ...pid },
  tool(async ({ projectId }) => {
    const project = await call<{ slug: string }>(`/v1/projects/${projectId}`);
    const { logs } = await call<{ logs: { slug: string }[] }>('/v1/logs');
    return ok({ events: logs.filter((l) => l.slug === project.slug) });
  }),
);

server.tool(
  'get_metrics',
  'Sampled resource usage over time (CPU, memory, disk, network in/out) for a project. range: 1h | 6h | 24h | 3d.',
  { ...pid, range: z.enum(['1h', '6h', '24h', '3d']).optional() },
  tool(async ({ projectId, range }) =>
    ok(await call(`/v1/projects/${projectId}/observability?range=${range ?? '24h'}`)),
  ),
);

server.tool(
  'get_traffic',
  'Aggregated traffic for a project: hourly buckets, totals (requests, 2xx/4xx/5xx, bytes, latency) and top paths.',
  { ...pid },
  tool(async ({ projectId }) => ok(await call(`/v1/projects/${projectId}/traffic`))),
);

server.tool(
  'get_stats',
  'Live container stats for a project: running, cpu %, memory used/limit, restart count.',
  { ...pid },
  tool(async ({ projectId }) => ok(await call(`/v1/projects/${projectId}/stats`))),
);

server.tool(
  'get_deployments',
  'Deployment history for a project (version sha, message, kind, status, date).',
  { ...pid },
  tool(async ({ projectId }) => ok(await call(`/v1/projects/${projectId}/deployments`))),
);

server.tool(
  'get_incidents',
  'Watcher incidents for a project (crashes, error-rate spikes, missed heartbeats) with the AI diagnosis: root cause, severity, confidence, suggested fix.',
  { ...pid, status: z.enum(['open', 'all']).optional() },
  tool(async ({ projectId, status }) =>
    ok(await call(`/v1/projects/${projectId}/incidents?status=${status ?? 'open'}`)),
  ),
);

server.tool(
  'get_incident_context',
  'Get the complete investigation context for one incident in a single call: ticket and diagnosis, human/agent comments, evidence, affected sessions and replays, code-change history, surfaces/devices, and impacted-user trend. This marks the agent as actively analyzing so Activity can show live progress; report findings with add_incident_note and update the phase with update_incident_progress.',
  {
    ...pid,
    incidentId: z
      .string()
      .uuid()
      .describe('The incident id from the shared Everock prompt or get_incidents.'),
  },
  tool(async ({ projectId, incidentId }) => {
    const base = `/v1/projects/${projectId}/incidents/${incidentId}`;
    const incident = await ensureAgentAssigned(
      projectId,
      incidentId,
      await call<IncidentEnvelope>(base),
    );
    await updateIncidentProgress(
      projectId,
      incidentId,
      'analyzing',
      'active',
      'Loading and correlating incident evidence.',
    );
    const [comments, evidence, replays, changes, surfaces, impact] = await Promise.all([
      call(`${base}/comments`),
      call(`${base}/evidence`),
      call(`${base}/replays`),
      call(`${base}/changes`),
      call(`${base}/surfaces`),
      call(`${base}/impact`),
    ]);
    return ok({ incident, comments, evidence, replays, changes, surfaces, impact });
  }),
);

server.tool(
  'update_incident_progress',
  'Update the live working state shown in the incident Activity. Call active when beginning analysis, preparing a proposal, or correcting; call completed or failed as soon as that phase ends. This controls the shimmer and does not create a chat message.',
  {
    ...pid,
    incidentId: z.string().uuid().describe('The incident id (from get_incidents).'),
    phase: z.enum(['analyzing', 'proposing', 'correcting']),
    status: z.enum(['active', 'completed', 'failed']),
    detail: z.string().max(500).optional(),
  },
  tool(async ({ projectId, incidentId, phase, status, detail }) => {
    await ensureAgentAssigned(projectId, incidentId);
    await updateIncidentProgress(projectId, incidentId, phase, status, detail);
    return ok({ ok: true, phase, status });
  }),
);

server.tool(
  'resolve_incident',
  'Mark a watcher incident as resolved (after fixing the underlying cause).',
  { ...pid, incidentId: z.string().uuid().describe('The incident id (from get_incidents).') },
  tool(async ({ projectId, incidentId }) =>
    ok(await call(`/v1/projects/${projectId}/incidents/${incidentId}/resolve`, { method: 'POST' })),
  ),
);

server.tool(
  'add_incident_note',
  "Write a note into an incident's timeline — it shows inline in the Everock chat for that incident. Use it to report a finding, the root cause you identified, or your progress as you investigate, so the human watching sees your reasoning. This is a comment, NOT a code change — use propose_change to submit a fix.",
  {
    ...pid,
    incidentId: z.string().uuid().describe('The incident id (from get_incidents).'),
    note: z.string().min(1).max(4000).describe('The finding / root cause / progress note. Plain text or markdown.'),
    author: z
      .string()
      .max(120)
      .optional()
      .describe('Display name shown on the note (default: the calling agent, e.g. "Claude Code").'),
  },
  tool(async ({ projectId, incidentId, note, author }) => {
    await ensureAgentAssigned(projectId, incidentId);
    return ok(
      await call(`/v1/projects/${projectId}/incidents/${incidentId}/comments`, {
        method: 'POST',
        body: { body: note, authorName: author ?? activeAgentName() },
      }),
    );
  }),
);

server.tool(
  'get_env',
  'Environment variables for a project (decrypted values — the owner is asking).',
  { ...pid },
  tool(async ({ projectId }) => ok(await call(`/v1/projects/${projectId}/env`))),
);

// ── act: safe write path ──
server.tool(
  'propose_change',
  'THE safe way to change production code. Submit a set of files (full content, or null to delete); the platform audits the proposal (protected paths, secrets, size), snapshots the app, applies, verifies (build), and AUTOMATICALLY ROLLS BACK if verification fails. Every step lands in the immutable change ledger. Returns the proposal with its status.',
  {
    ...pid,
    title: z.string().min(3).max(200).describe('Short imperative summary of the change.'),
    description: z.string().max(2000).optional().describe('Why this change is needed.'),
    files: z
      .array(
        z.object({
          path: z.string().describe('Path relative to the app root, e.g. src/index.ts'),
          content: z.string().nullable().describe('Full new file content (utf8), or null to delete.'),
        }),
      )
      .min(1)
      .max(40),
    requireApproval: z
      .boolean()
      .optional()
      .describe('true → wait for the owner to approve in the panel instead of auto-applying.'),
    incidentId: z
      .string()
      .uuid()
      .optional()
      .describe('The incident this fix resolves — links it into that incident timeline. Pass the id you were handed.'),
  },
  tool(async ({ projectId, title, description, files, requireApproval, incidentId }) => {
    if (incidentId) await ensureAgentAssigned(projectId, incidentId);
    if (incidentId) {
      await updateIncidentProgress(
        projectId,
        incidentId,
        'proposing',
        'active',
        'Auditing and submitting the proposed file changes.',
      );
    }
    try {
      const proposal = await call(`/v1/projects/${projectId}/proposals`, {
        method: 'POST',
        body: { title, description, files, requireApproval, incidentId },
      });
      if (incidentId) {
        await updateIncidentProgress(projectId, incidentId, 'proposing', 'completed');
      }
      return ok(proposal);
    } catch (error) {
      if (incidentId) {
        await updateIncidentProgress(
          projectId,
          incidentId,
          'proposing',
          'failed',
          error instanceof Error ? error.message.slice(0, 500) : 'Proposal failed.',
        ).catch(() => undefined);
      }
      throw error;
    }
  }),
);

server.tool(
  'get_proposals',
  'Change proposals for a project with status (pending/approved/applying/applied/failed/rejected), audit findings, and result shas. Check this after propose_change to see if the change applied or was rolled back.',
  { ...pid },
  tool(async ({ projectId }) => ok(await call(`/v1/projects/${projectId}/proposals`))),
);

server.tool(
  'get_ledger',
  'The immutable change ledger for a project: every proposal transition (proposed/approved/applied/rolled_back) with actor, sha, and evidence. The audit trail of everything agents did to production.',
  { ...pid },
  tool(async ({ projectId }) => ok(await call(`/v1/projects/${projectId}/ledger`))),
);

// ── act ──
server.tool(
  'restart_project',
  'Restart a project container (applies new env vars / recovers from a crash).',
  { ...pid },
  tool(async ({ projectId }) =>
    ok(await call(`/v1/projects/${projectId}/restart`, { method: 'POST' })),
  ),
);

server.tool(
  'rollback_deployment',
  'Roll a project back to a previous deployment by its sha (creates a new version).',
  { ...pid, sha: z.string().describe('The deployment sha to restore (from get_deployments).') },
  tool(async ({ projectId, sha }) =>
    ok(await call(`/v1/projects/${projectId}/rollback`, { method: 'POST', body: { sha } })),
  ),
);

server.tool(
  'publish_project',
  'Publish a project (dev → prod: build the app and serve the built output).',
  { ...pid },
  tool(async ({ projectId }) =>
    ok(await call(`/v1/projects/${projectId}/publish`, { method: 'POST' })),
  ),
);

server.tool(
  'unpublish_project',
  'Unpublish a project (prod → dev: back to the live hot-reload dev server).',
  { ...pid },
  tool(async ({ projectId }) =>
    ok(await call(`/v1/projects/${projectId}/unpublish`, { method: 'POST' })),
  ),
);

return server;
}

export const server = createServer();
