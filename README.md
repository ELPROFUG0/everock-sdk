# Everock SDKs

Instrument your application and send errors, requests, traces and session context to Everock. Use a project ingestion key and the collector URL from your project setup.

| Package | Use |
| --- | --- |
| [@everock/sdk](packages/sdk) | Browser, Node.js and edge telemetry |
| [@everock/next](packages/next) | Next.js integration |
| [@everock/vite](packages/vite) | Client instrumentation in Vite applications |
| [@everock/nest](packages/nest) | NestJS instrumentation |
| [Python SDK](packages/python) | Python services and OpenTelemetry exporters |
| [Everock CLI](apps/cli) | Connect your repository and configure your project |
| [Everock MCP](apps/mcp) | Give your coding agent access to project telemetry |

See the [Everock documentation](https://everock.dev/docs) for installation and configuration. Source on main may include changes newer than the published npm beta.

## Development

Use Node.js 22 or newer and pnpm 10.6.3. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

The build generates six npm archives in dist/npm. The smoke test installs those archives into a temporary project and exercises their public entry points. For Python, use Python 3.10+ and run:

```sh
cd packages/python
python -m venv .venv
. .venv/bin/activate
python -m pip install -e '.[test,fastapi,flask,django,httpx,requests]'
python -m pytest
```

Licensed under [Apache-2.0](LICENSE). See [NOTICE](NOTICE).
