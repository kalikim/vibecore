# Vibecore CLI

Local-first application orchestration for AI-assisted developers.

This is an experimental alpha, not a production-readiness guarantee. Requires
Node.js 22 or newer. The public source is MIT licensed.

Once this version is published to npm, run from your application's directory:

```sh
npx @codexsafari/vibecore@0.1.0-alpha.1 --help
npx @codexsafari/vibecore@0.1.0-alpha.1 adopt --json
npx @codexsafari/vibecore@0.1.0-alpha.1 plan --environment dev --budget-conscious
```

Inspection and advisory planning do not deploy your application. Review plans
before approving mutations. Never paste secrets into prompts or commit them.
Cloud operations require separately configured tools, credentials, and targets.

Includes repository discovery, local orchestration, database tooling, GitHub
workflow configuration, OpenAPI scaffolding, provider-specific deployment commands,
and Nginx configuration candidates. Support varies by mode: `init` creates a
manifest, not a full app; Nginx candidates do not install certificates or activate
server configuration. Native editor/MCP integrations are not included.

See the [source and setup documentation](https://github.com/kalikim/vibecore)
for supported workflows and release limitations.
