# Editor and Coding Agent Integrations

Status: Design proposal

The CLI is Vibecore's primary interface. Editor and coding-agent integrations will
use the same orchestration engine so policies do not change based on where a command
originates.

## Integration layers

### CLI

Humans and agents can invoke stable commands and request JSON output:

```sh
vibe doctor --json
vibe deploy --environment preview --plan --json
```

Only `vibe doctor` is implemented today. Other commands in this document describe
the planned interface.

### Project instructions

`vibe integrate <target>` will be able to generate project-level instructions that
teach an editor:

- to run diagnosis before proposing infrastructure fixes;
- to request a plan before changing databases or deployment configuration;
- never to place secret values in tracked files;
- to preserve the declared workspace and adapter boundaries;
- to use the JSON interface when it needs structured evidence.

These files remain reviewable and editable by the project owner.

### Model Context Protocol

The planned local MCP server will expose focused tools and resources:

```sh
vibe mcp serve
```

The configuration below is illustrative and will not work until that command ships.

## Cursor

Cursor supports project MCP configuration in `.cursor/mcp.json`. The planned setup is:

```json
{
  "mcpServers": {
    "vibecore": {
      "command": "vibe",
      "args": ["mcp", "serve"],
      "env": {
        "VIBE_MODE": "plan-first"
      }
    }
  }
}
```

Vibecore will also be able to generate project rules in `.cursor/rules` that explain
the manifest, plan-first workflow, and security boundaries. Secret values must not
be embedded in `mcp.json`; they should remain in the selected secret source.

## Visual Studio Code

VS Code supports workspace MCP configuration in `.vscode/mcp.json`. Its schema uses
`servers` rather than Cursor's `mcpServers`:

```json
{
  "servers": {
    "vibecore": {
      "type": "stdio",
      "command": "vibe",
      "args": ["mcp", "serve"],
      "env": {
        "VIBE_MODE": "plan-first"
      }
    }
  }
}
```

Vibecore can complement MCP with `.github/copilot-instructions.md`, focused custom
agents, and hooks. Configuration generation must preserve existing user content.

## Google Antigravity

Antigravity supports local and remote MCP servers. Local server configuration is
managed through its MCP interface and stored in the user's Gemini configuration.
The planned Vibecore integration will register the same local `vibe mcp serve`
process and offer a project skill describing the plan and approval workflow.

Because this configuration can be user-scoped rather than repository-scoped,
Vibecore will show the exact target and proposed changes before registration.

## Tool behavior

All integrations share these rules:

- discovery and diagnosis are read-only;
- mutating operations return a plan before execution;
- every tool declares required permissions;
- production targets require explicit selection and policy approval;
- secrets are resolved by the executor, never returned to the agent;
- tool output includes stable diagnostic and action codes;
- unsupported operations fail honestly rather than falling back to guessed commands.

## Proposed setup commands

```sh
vibe integrate cursor --plan
vibe integrate vscode --plan
vibe integrate antigravity --plan
vibe integrate all --plan
```

Applying a setup plan will create or merge only the selected project configuration.
User-global configuration will require a separate explicit flag.

