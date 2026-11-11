#!/usr/bin/env tsx

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { createServer } from './server.js';

const host = process.env.MCP_HOST ?? '127.0.0.1';
const port = Number(process.env.MCP_PORT ?? 4010);
const publicUrl = (process.env.MCP_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, '');
const resource = `${publicUrl}/mcp`;
const supabaseUrl = (process.env.SUPABASE_URL ?? '').replace(/\/$/, '');
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
  agentKind?: AgentKind,
): Promise<AuthInfo | null> {
  const response = await fetch(`${supabaseUrl}/auth/v1/oauth/userinfo`, {
    headers: { authorization: `Bearer ${token}` },
  }).catch(() => null);
  if (!response?.ok) return null;

  const user = (await response.json()) as {
    sub?: string;
    email?: string;
    name?: string;
    picture?: string;
  };
  const claims = decodeClaims(token);
  const email = user.email ?? claims.email;
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
      agentKind,
    },
  };
}

const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 });
const transports = new Map<string, StreamableHTTPServerTransport>();
const sessionAgents = new Map<string, AgentKind>();

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

app.route({
  method: ['GET', 'POST', 'DELETE'],
  url: '/mcp',
  async handler(request, reply) {
    const header = request.headers.authorization;
    const token = header?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) return unauthorized(reply);

    const sessionIdHeader = request.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;
    const initializeClientName = isInitializeRequest(request.body)
      ? request.body.params.clientInfo.name
      : undefined;
    const agentKind =
      sessionAgents.get(sessionId ?? '') ??
      detectAgentKind([
        initializeClientName ?? '',
        ...(Array.isArray(request.headers['x-agent-client'])
          ? request.headers['x-agent-client']
          : [request.headers['x-agent-client'] ?? '']),
        request.headers['user-agent'] ?? '',
      ]);
    const auth = await validateAccessToken(token, agentKind);
    if (!auth) return unauthorized(reply);

    const raw = request.raw as typeof request.raw & { auth?: AuthInfo };
    raw.auth = auth;

    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport && request.method === 'POST' && isInitializeRequest(request.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        enableJsonResponse: true,
        onsessioninitialized(id) {
          transports.set(id, transport!);
          if (agentKind) sessionAgents.set(id, agentKind);
        },
      });
      transport.onclose = () => {
        const id = transport?.sessionId;
        if (id) {
          transports.delete(id);
          sessionAgents.delete(id);
        }
      };
      transport.onerror = (error) => {
        app.log.error({ err: error, sessionId: transport?.sessionId }, 'MCP transport error');
      };
      await createServer().connect(transport);
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
    } catch (error) {
      app.log.error({ err: error, sessionId }, 'MCP request failed');
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
    }
  },
});

await app.listen({ host, port });
console.error(`Everock remote MCP ready → ${resource}`);
