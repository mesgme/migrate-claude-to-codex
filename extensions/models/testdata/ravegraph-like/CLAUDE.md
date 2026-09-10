# Project

A TypeScript monorepo using pnpm workspaces.

## Tech Stack

- TypeScript 5.x
- React 19 with Next.js 15
- PostgreSQL 16 with Drizzle ORM
- Tailwind CSS v4

## Development

### Before Pushing

Run CI checks locally and fix any errors before pushing:
```bash
pnpm lint
pnpm typecheck
pnpm test
```

**Never push code that fails these checks.**

### Git Workflow

- **Never push directly to main** — always use a feature branch + PR
- **Never merge PRs** — create PRs and leave merging to the user
- Use `--author="Claude Code <claude-code@anthropic.com>"` for all commits

## Architecture

### Domain Layer

Keep domain logic pure — no framework imports, no I/O.

### Repository Pattern

All data access goes through repository interfaces defined in `src/domain/`.

## Memory Rules

- Save user preferences across sessions
- Use `.claude/memory/` directory for persistence
- Never store secrets in memory files

## Hooks

### Pre-commit Hook

Runs `pnpm lint` and `pnpm typecheck` before each commit.
Configure in `.claude/settings.json`.
