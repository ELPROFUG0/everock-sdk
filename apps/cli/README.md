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

Requires Node.js 22 or newer. Build/package from the workspace with `npm pack`.
Until registry publication, install the generated tarball with
`npm install -g /path/to/everock-cli-0.0.0.tgz`.
