# Everock CLI

Sign in to Everock with `everock login`. For self-hosted installations, use `everock login --api-url URL`. Approve the code shown in your
terminal, then let your coding agent use the saved CLI session. The local MCP
uses the same session without copying API keys.

Use `everock projects` to list projects, `everock init --name "My app"` to
create/link a project and retrieve SDK configuration, and `everock github
connect` for initial GitHub authorization. Repository linking uploads metadata
only. Your coding agent installs/configures the SDK for the detected runtime.

`everock logout` revokes the session and removes the local credential.
For headless CI, pipe the key from your secret manager into
`everock login --api-key-stdin --api-url URL`. This keeps the credential out of
the CLI command line and shell history.
Use HTTPS for remote API origins. Local HTTP login is limited to loopback hosts.

## Install from the public source

The CLI and local MCP are distributed as source for now. Use Node.js 22+ and the pnpm version pinned in the repository. From a new directory:

```sh
git clone https://github.com/ELPROFUG0/everock-sdk.git
cd everock-sdk
corepack pnpm install --frozen-lockfile
corepack pnpm run build
npm install --global ./dist/npm/everock-cli-*.tgz ./dist/npm/everock-mcp-*.tgz
everock --help
```

Run `everock login` on your machine, then run `everock link --project-id <id>` from your application's checkout. Configure your local agent to launch `everock-mcp` over stdio. Both commands use the same saved login.
