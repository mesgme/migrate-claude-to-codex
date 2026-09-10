# @mesgme/migrate-claude-to-codex

A swamp extension that scans a repo's Claude Code configuration (CLAUDE.md,
.claude/settings.json, commands, skills) and generates equivalent Codex
AGENTS.md files. Handles swamp-managed sections, recursive subdirectory
scanning, and negative-to-positive rule rewrites.

## Usage

```bash
# Add the model to your swamp project
swamp model create migrate --type @mesgme/migrate-claude-to-codex \
  --set repoPath=/path/to/target/repo

# Scan for Claude Code configuration
swamp model method run migrate scan

# Generate AGENTS.md (dry run)
swamp model method run migrate generate

# Generate and write AGENTS.md to disk
swamp model method run migrate generate --set writeToDisk=true

# Or do both in one step
swamp model method run migrate migrate --set writeToDisk=true
```

## Features

- **Section-aware parsing**: Splits CLAUDE.md into heading-based sections,
  classifies each as keep/transform/drop
- **Swamp-managed section handling**: Extracts and transforms swamp project
  rules, drops Claude-specific subsections (Getting Started, Communication)
- **Identity replacement**: Rewrites "Claude Code" references to tool-agnostic
  alternatives
- **Negative-to-positive rewrites**: Converts "Never push directly to main"
  to "Create a branch and open a PR"
- **Recursive scanning**: Finds CLAUDE.md at any depth (skips node_modules,
  .git, etc.)
- **Swamp dual-tool support**: Detects `.swamp.yaml` and prepares config
  updates to add codex alongside claude

## Example

Given a CLAUDE.md with Claude-specific sections:

```markdown
# Project

## Tech Stack
- TypeScript 5.x
- React 19

## Memory Rules
- Save preferences across sessions

## Git Workflow
- **Never push directly to main** — always use a feature branch + PR
- Use `--author="Claude Code <claude-code@anthropic.com>"`
```

The extension generates an AGENTS.md that preserves domain content, drops
Claude-specific sections, and rewrites references:

```markdown
# AGENTS.md

> Auto-generated from project configuration (CLAUDE.md).

# Project

## Tech Stack
- TypeScript 5.x
- React 19

## Git Workflow Rules
- **Create a branch and open a PR** — do not push directly to main
- Use `--author="the coding agent <coding-agent@users.noreply.github.com>"`
```

## Development

```bash
# Type check
~/.swamp/deno/deno check extensions/models/migrate.ts

# Run tests
~/.swamp/deno/deno test --allow-read --allow-write --allow-env extensions/models/migrate_test.ts

# Run smoke tests against real repos
SMOKE_TEST=1 ~/.swamp/deno/deno test --allow-read --allow-write --allow-env extensions/models/migrate_test.ts
```
