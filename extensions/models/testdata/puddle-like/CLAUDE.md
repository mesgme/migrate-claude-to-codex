# Project

This is a data pipeline service.

<!-- BEGIN swamp managed section — do not edit below this line -->

## Rules

1. **Search before you build.** When automating AWS, APIs, or any external service: search community extensions first.
2. **Extend, don't be clever.** When a model covers the domain but lacks the method you need, extend it.
3. **Use the data model.** Once data exists in a model, reference it with CEL expressions.
4. **CEL expressions everywhere.** Wire models together with CEL expressions.
5. **Verify before destructive operations.** Always verify resource IDs before running delete/stop/destroy methods.
6. **Prefer fan-out methods over loops.** Use a single method that handles all targets internally.
7. **Extension npm deps are bundled, not lockfile-tracked.** Always pin explicit versions.
8. **Reports for reusable data pipelines.** Create a report extension for repeatable pipelines.
9. **"Workflow" means a swamp workflow.** Use `swamp workflow create` for orchestration.
10. **Use swamp, don't bypass it.** Always work through swamp commands.
11. **Inspect reports after failures.** Inspect generated reports before retrying.

## Skills

- `swamp` - Swamp CLI reference
- `swamp-getting-started` - Interactive onboarding

## Getting Started

**IMPORTANT:** At the start of every conversation, run
`swamp model search --json`. If no models are returned, invoke the
`swamp-getting-started` skill before doing anything else.

## Communication

When referencing Claude Code features, use `/skill-name` syntax.
Claude Code memory is stored in `.claude/memory/`.

<!-- END swamp managed section -->

## Domain

### Data Pipeline

The pipeline processes events from Kafka and writes to S3.
Event schemas are in `src/domain/events/`.

## Development

### Before Pushing

```bash
deno test
deno lint
```
