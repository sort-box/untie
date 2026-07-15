# Untie

TanStack Start application with a small Electron desktop shell, Convex data,
Clerk authentication, Tailwind CSS, and shadcn/ui.

## Requirements

- Node.js 22 or newer
- Bun 1.3 or newer
- A Clerk application
- A Convex project

## First-time setup

```bash
bun install
cp .env.example .env.local
bunx --bun convex dev --once
```

Add the Clerk publishable and secret keys to `.env.local`. `bunx --bun convex dev --once`
fills in `CONVEX_DEPLOYMENT` and `VITE_CONVEX_URL` after you select or create a
Convex project.

Activate the Convex integration in Clerk, copy its Frontend API URL, and store
it on the Convex deployment:

```bash
bunx --bun convex env set CLERK_JWT_ISSUER_DOMAIN https://your-clerk-domain
```

The Clerk Convex integration is configured in `convex/auth.config.ts`. A fresh
sign-out and sign-in may be required after enabling the integration.

## Run the app

```bash
# Browser development with the Convex watcher
bun run dev

# Electron development with the Convex watcher
bun run dev:desktop
```

The Electron renderer is sandboxed and context-isolated. The preload bridge is
in `electron/preload.cjs`; keep native capabilities behind that bridge instead
of enabling Node.js in the renderer.

## Build

```bash
# TanStack Start browser/server bundles
bun run build

# Unpacked desktop application for local testing
bun run desktop:pack

# Platform installer (DMG, NSIS, or AppImage)
bun run desktop:dist
```

Desktop output is written to `release/`. Installers intended for distribution
still need the platform's signing and notarization credentials.

## Quality checks

```bash
bun run typecheck
bun run check
bun run test
```

## shadcn/ui

The project is initialized through `components.json`. Add components with:

```bash
bunx --bun shadcn@latest add button
```

The shadcn MCP server is configured for Claude-compatible clients, Cursor, and
VS Code in the project-local MCP files. Codex currently reads its MCP servers
from the user config; add the following to `~/.codex/config.toml` if it is not
already present:

```toml
[mcp_servers.shadcn]
command = "bunx"
args = ["--bun", "shadcn@latest", "mcp"]
```

## AI guidance

- TanStack Intent mappings are in `AGENTS.md` and `.cursorrules` and load
  version-matched guidance from the installed TanStack packages.
- Official shadcn, Convex, and Clerk skills are installed under
  `.agents/skills/` and linked into the supported project-local agent folders.
- `skills-lock.json` records the installed skill sources and versions.

Review third-party skill instructions before allowing an agent to execute
commands with external side effects.
