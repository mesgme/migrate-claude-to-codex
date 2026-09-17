# @mesgme/migrate-claude-to-codex

A swamp extension that scans a repo's Claude Code configuration and generates
an AAIF-standard AGENTS.md file for multi-agent compatibility.

This repository is managed with [swamp](https://github.com/swamp-club/swamp).

## Rules

1. **Search before you build.** When automating AWS, APIs, or any external service: (a) search community extensions with `swamp extension search <query>` — prefer `@swamp/*` official extensions first, (b) search local/installed types with `swamp model type search <query>`, (c) if a community extension exists, install it with `swamp extension pull <package>` instead of building from scratch, (d) extend an existing type if it covers the domain but lacks the method you need, (e) only create a custom extension model in `extensions/models/` as a last resort.
2. **Extend, don't be clever.** When a model covers the domain but lacks the method you need, extend it with `export const extension` — don't bypass it with shell scripts, CLI tools, or multi-step hacks. One method, one purpose. Use `swamp model type describe <type> --json` to check available methods.
3. **Use the data model.** Once data exists in a model (via `lookup`, `start`, `sync`, etc.), reference it with CEL expressions. Don't re-fetch data that's already available.
4. **CEL expressions everywhere.** Wire models together with CEL expressions. Always prefer `data.latest("<name>", "<dataName>").attributes.<field>` over the deprecated `model.<name>.resource.<spec>.<instance>.attributes.<field>` pattern.
5. **Verify before destructive operations.** Always `swamp model get <name> --json` and verify resource IDs before running delete/stop/destroy methods.
6. **Prefer fan-out methods over loops.** When operating on multiple targets, use a single method that handles all targets internally (factory pattern) rather than looping N separate `swamp model method run` calls against the same model. A single fan-out method acquires the lock once and produces all outputs in one execution.
7. **Extension npm deps are bundled, not lockfile-tracked.** Swamp's bundler inlines all npm packages (except zod) into extension bundles at bundle time. Always pin explicit versions in `npm:` import specifiers (e.g., `npm:lodash-es@4.17.21`).
8. **Reports for reusable data pipelines.** When the task involves building a repeatable pipeline to transform, aggregate, or analyze model output, create a report extension.
9. **"Workflow" means a swamp workflow.** A declarative YAML DAG of model-method steps authored via `swamp workflow create`.
10. **Use swamp, don't bypass it.** Always work through swamp commands — don't go around them with raw shell tools. Use `swamp data query` to find data, not `grep`/`find` on `.swamp/` files. Use model methods to interact with resources, not raw CLI tools when a model type already wraps that API. Composing with `--json` output (e.g. piping through `jq`) is fine.
11. **Inspect reports after failures.** When a model method or workflow run fails, inspect its generated reports before retrying or changing definitions.

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

## Commands

Use `swamp --help` to see available commands. For a machine-readable JSON
schema of the CLI, run `swamp help [<command>...]`.

## Constraints

- The model type string `@mesgme/migrate-claude-to-codex` and manifest name are published
  identifiers. Do not change them without a major version bump.
