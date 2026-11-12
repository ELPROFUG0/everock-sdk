#!/usr/bin/env tsx

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import Fastify, { type FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { SessionPool } from './session-pool.js';
import { serviceUrl } from './service-url.js';
import { createServer } from './server.js';

const host = process.env.MCP_HOST ?? '127.0.0.1';
const port = Number(process.env.MCP_PORT ?? 4010);
const publicUrl = (process.env.MCP_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, '');
const resource = `${publicUrl}/mcp`;
const supabaseUrl = process.env.SUPABASE_URL ? serviceUrl(process.env.SUPABASE_URL) : '';
const authorizationServer = `${supabaseUrl}/auth/v1`;
const resourceMetadataUrl = `${publicUrl}/.well-known/oauth-protected-resource`;

if (!supabaseUrl) {
  console.error('SUPABASE_URL is required by the remote MCP server.');
  process.exit(1);
}

if (!process.env.EVEROCK_API_TOKEN) {
  console.error('EVEROCK_API_TOKEN is required by the remote MCP server.');
  process.exit(1);
}

type JwtClaims = {
  sub?: string;
  email?: string;
  client_id?: string;
  scope?: string;
  exp?: number;
};

type AgentKind = 'codex' | 'claude';

function detectAgentKind(value: string | string[] | undefined): AgentKind | undefined {
  const client = (Array.isArray(value) ? value.join(' ') : (value ?? '')).toLowerCase();
  if (client.includes('codex') || client.includes('openai')) return 'codex';
  if (client.includes('claude') || client.includes('anthropic')) return 'claude';
  return undefined;
}

function decodeClaims(token: string): JwtClaims {
  try {
    const payload = token.split('.')[1];
    if (!payload) return {};
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as JwtClaims;
  } catch {
    return {};
  }
}

function unauthorized(reply: {
  header(name: string, value: string): unknown;
  code(status: number): { send(body: unknown): unknown };
}) {
  reply.header(
    'WWW-Authenticate',
    `Bearer resource_metadata="${resourceMetadataUrl}", scope="openid email profile"`,
  );
  return reply.code(401).send({ error: 'unauthorized', error_description: 'OAuth login required.' });
}

async function validateAccessToken(
  token: string,
): Promise<AuthInfo | null> {
  const response = await fetch(`${supabaseUrl}/auth/v1/oauth/userinfo`, {
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) return null;
    throw new Error('Identity provider unavailable');
  }

  const user = (await response.json()) as {
    sub?: string;
    email?: string;
    name?: string;
    picture?: string;
  };
  const claims = decodeClaims(token);
  const email = user.email;
  // Supabase OAuth access tokens always carry client_id. Requiring it keeps a
  // regular first-party browser session token from being replayed against the
  // full-access MCP resource.
  if (!user.sub || !email || !claims.client_id) return null;

  return {
    token,
    clientId: claims.client_id,
    scopes: ['openid', 'email', 'profile', 'everock:full'],
    expiresAt: claims.exp,
    resource: new URL(resource),
    extra: {
      userId: user.sub,
      email,
      name: user.name,
      picture: user.picture,
      permissions: ['*'],
    },
  };
}

const app = Fastify({
  logger: {
    serializers: {
      req: request => ({ method: request.method, route: request.routeOptions?.url ?? '[unmatched]' }),
      // Parser and transport errors may quote request data in messages and stacks.
      err: () => ({ type: 'RequestError', message: 'Request failed', stack: '' }),
    },
  },
  frameworkErrors(error, _request, reply) {
    (reply as FastifyReply).code(error.statusCode ?? 400).send({ error: 'invalid_request' });
  },
  requestTimeout: 30000,
  bodyLimit: 2 * 1024 * 1024,
});
app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
  const status = error.statusCode ?? 500;
  if (status >= 500) request.log.error({ status }, 'MCP handler failed');
  return reply.code(status).send({ error: status >= 500 ? 'internal_error' : 'invalid_request' });
});
app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not_found' }));
const sessions = new SessionPool<{ transport: StreamableHTTPServerTransport; agentKind?: AgentKind }>(1024, 16);
const idleTimeout = 60 * 60 * 1000;
const cleanup = setInterval(() => {
  for (const { transport } of sessions.expireBefore(Date.now() - idleTimeout)) {
    void transport.close().catch(() => app.log.error('MCP session cleanup failed'));
  }
}, 60_000);
cleanup.unref();
app.addHook('onClose', async () => {
  clearInterval(cleanup);
  await Promise.allSettled(sessions.expireBefore(Infinity).map(({ transport }) => transport.close()));
});

const protectedResourceMetadata = {
  resource,
  authorization_servers: [authorizationServer],
  scopes_supported: ['openid', 'email', 'profile'],
  bearer_methods_supported: ['header'],
  resource_documentation: `${publicUrl}/about`,
};

app.get('/health', async () => ({
  ok: true,
  transport: 'streamable-http',
  auth: 'oauth-2.1',
  resource,
}));

app.get('/about', async () => ({
  name: 'Everock MCP',
  description:
    'Full access to projects, incidents, activity, sessions, findings, logs, deployments, environment, proposals and runtime actions.',
  permissions: ['*'],
}));

app.get('/.well-known/oauth-protected-resource', async () => protectedResourceMetadata);
app.get('/.well-known/oauth-protected-resource/mcp', async () => protectedResourceMetadata);

const maxPendingTokenChecks = 64;
let pendingTokenChecks = 0;

app.route({
  method: ['GET', 'POST', 'DELETE'],
  url: '/mcp',
  async onRequest(request, reply) {
    const header = request.headers.authorization;
    const token = header?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) return unauthorized(reply);

    if (pendingTokenChecks >= maxPendingTokenChecks) {
      return reply.header('Retry-After', '1').code(503).send({ error: 'auth_busy' });
    }

    pendingTokenChecks++;
    try {
      let auth: AuthInfo | null;
      try {
        auth = await validateAccessToken(token);
      } catch {
        return reply.header('Retry-After', '1').code(503).send({ error: 'auth_unavailable' });
      }
      if (!auth) return unauthorized(reply);
      Object.assign(request.raw, { auth });
    } finally {
      pendingTokenChecks--;
    }
  },
  async handler(request, reply) {
    const raw = request.raw as typeof request.raw & { auth: AuthInfo };
    const auth = raw.auth;
    const sessionIdHeader = request.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;
    const initializeClientName = isInitializeRequest(request.body)
      ? request.body.params?.clientInfo?.name
      : undefined;
    const agentKind =
      detectAgentKind([
        initializeClientName ?? '',
        ...(Array.isArray(request.headers['x-agent-client'])
          ? request.headers['x-agent-client']
          : [request.headers['x-agent-client'] ?? '']),
        request.headers['user-agent'] ?? '',
      ]);
    if (auth.extra) auth.extra.agentKind = agentKind;

    const owner = JSON.stringify([auth.extra?.userId, auth.clientId]);
    const session = sessionId ? sessions.get(sessionId, owner, Date.now()) : undefined;
    if (sessionId && !session) {
      return reply.code(404).send({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found.' }, id: null });
    }
    if (session?.agentKind && auth.extra) auth.extra.agentKind = session.agentKind;
    let transport = session?.transport;
    let initializationId: string | undefined;

    if (!transport && request.method === 'POST' && isInitializeRequest(request.body)) {
      const id = randomUUID();
      const reservation = sessions.reserve(id, owner, () => ({
        transport: new StreamableHTTPServerTransport({ sessionIdGenerator: () => id, enableJsonResponse: true }),
        agentKind,
      }), Date.now());
      if (!reservation) return reply.header('Retry-After', '60').code(429).send({ error: 'session_limit_reached' });
      initializationId = id;
      transport = reservation.transport;
      transport.onclose = () => sessions.remove(id);
      transport.onerror = () => app.log.error('MCP transport error');
      try {
        await createServer('http').connect(transport);
      } catch (error) {
        sessions.remove(id);
        await transport.close();
        throw error;
      }
    }

    if (!transport) {
      return reply.code(400).send({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Invalid or missing MCP session.' },
        id: null,
      });
    }

    reply.hijack();
    try {
      await transport.handleRequest(raw, reply.raw, request.body);
    } catch {
      request.log.error('MCP request failed');
      if (!reply.raw.headersSent) {
        reply.raw.statusCode = 500;
        reply.raw.setHeader('content-type', 'application/json');
        reply.raw.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal MCP server error.' },
            id: null,
          }),
        );
      }
    } finally {
      if (initializationId && (!transport.sessionId || reply.raw.statusCode >= 400)) {
        sessions.remove(initializationId);
        await transport.close();
      }
    }
  },
});

await app.listen({ host, port });
console.error(`Everock remote MCP ready → ${resource}`);
