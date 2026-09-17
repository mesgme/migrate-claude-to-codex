# @mesgme/migrate-claude-to-codex

A swamp extension that scans a repo's Claude Code configuration and generates
an AAIF-standard AGENTS.md file for multi-agent compatibility.

## Development

```bash
# Type check
~/.swamp/deno/deno check extensions/models/migrate.ts

# Run tests (TDD — write failing tests first)
~/.swamp/deno/deno test --allow-read --allow-write --allow-env extensions/models/migrate_test.ts

# Run smoke tests against real repos
SMOKE_TEST=1 ~/.swamp/deno/deno test --allow-read --allow-write --allow-env extensions/models/migrate_test.ts
```

## Architecture

Single-file extension model at `extensions/models/migrate.ts` with three methods:
- `scan` — reads Claude Code config files from a target repo
- `generate` — transforms scan data into AGENTS.md
- `migrate` — convenience: scan + generate in one call

Exported functions for unit testing: `parseMarkdownSections`, `extractSwampManagedSection`,
`classifySection`, `transformSection`, `walkForClaudeMd`.

## Testing

TDD is required — write failing tests in `extensions/models/migrate_test.ts` before
implementing. Tests use Deno's built-in test runner with fixtures in
`extensions/models/testdata/`.

## Constraints

- The model type string `@mesgme/migrate-claude-to-codex` and manifest name are published
  identifiers. Do not change them without a major version bump.
- Extension npm deps are bundled by swamp, not lockfile-tracked. Pin explicit versions in
  `npm:` import specifiers.
