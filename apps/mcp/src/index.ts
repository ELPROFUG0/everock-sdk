#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { server, apiOrigin } from './server.js';



const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `Everock MCP ready → ${apiOrigin()}`,
);
