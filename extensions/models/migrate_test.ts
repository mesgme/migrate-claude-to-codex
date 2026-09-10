import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  model,
  parseMarkdownSections,
  extractSwampManagedSection,
  classifySection,
  transformSection,
  walkForClaudeMd,
} from "./migrate.ts";
import type { MarkdownSection } from "./migrate.ts";

Deno.test("model type is @mesgme/migrate-claude-to-codex", () => {
  assertEquals(model.type, "@mesgme/migrate-claude-to-codex");
});

Deno.test("model has scan and generate methods", () => {
  assertExists(model.methods.scan);
  assertExists(model.methods.generate);
});

Deno.test("globalArguments requires repoPath", () => {
  const schema = model.globalArguments;
  const result = schema.safeParse({});
  assertEquals(result.success, false);

  const valid = schema.safeParse({ repoPath: "/some/repo" });
  assertEquals(valid.success, true);
});

Deno.test("scan method has a description", () => {
  assertEquals(typeof model.methods.scan.description, "string");
  assertEquals(model.methods.scan.description.length > 0, true);
});

Deno.test("generate method has a description", () => {
  assertEquals(typeof model.methods.generate.description, "string");
  assertEquals(model.methods.generate.description.length > 0, true);
});

Deno.test("model declares scan and output resources", () => {
  assertExists(model.resources.scan);
  assertExists(model.resources.output);
});

// ---------------------------------------------------------------------------
// Integration tests — scan and generate against fixture repo
// ---------------------------------------------------------------------------

const FIXTURE_PATH = new URL("testdata/sample-repo", import.meta.url).pathname;

function mockContext(
  repoPath: string,
): {
  ctx: Parameters<typeof model.methods.scan.execute>[1];
  written: Map<string, Record<string, unknown>>;
} {
  const written = new Map<string, Record<string, unknown>>();
  return {
    ctx: {
      globalArgs: { repoPath },
      writeResource: async (
        specName: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        written.set(specName, data);
        return { name };
      },
      readResource: async (specName: string) => {
        return written.get(specName) ?? null;
      },
    } as Parameters<typeof model.methods.scan.execute>[1],
    written,
  };
}

Deno.test("scan finds CLAUDE.md, settings.json, and commands", async () => {
  const { ctx, written } = mockContext(FIXTURE_PATH);
  await model.methods.scan.execute({} as Record<string, never>, ctx);

  const scan = written.get("scan") as {
    repoPath: string;
    files: Array<{ path: string; type: string }>;
  };
  assertExists(scan);
  assertEquals(scan.repoPath, FIXTURE_PATH);

  const types = scan.files.map((f) => f.type);
  assertEquals(types.includes("claude_md"), true);
  assertEquals(types.includes("settings"), true);
  assertEquals(types.includes("command"), true);
});

Deno.test("generate produces AGENTS.md content from scan", async () => {
  const { ctx, written } = mockContext(FIXTURE_PATH);
  // scan first
  await model.methods.scan.execute({} as Record<string, never>, ctx);
  // then generate
  await model.methods.generate.execute({}, ctx);

  const output = written.get("output") as {
    outputs: Array<{ relativePath: string; agentsMd: string }>;
    sourceFiles: string[];
  };
  assertExists(output);
  assertExists(output.outputs);
  assertEquals(output.outputs.length > 0, true);

  const agentsMd = output.outputs[0].agentsMd;
  // should contain content from CLAUDE.md
  assertEquals(agentsMd.includes("Always run tests before committing"), true);
  // should contain permission guardrails
  assertEquals(agentsMd.includes("npm test"), true);
  // should reference the deploy workflow
  assertEquals(agentsMd.includes("deploy"), true);
});

Deno.test("generate throws without prior scan", async () => {
  const { ctx } = mockContext(FIXTURE_PATH);
  let threw = false;
  try {
    await model.methods.generate.execute({}, ctx);
  } catch (e) {
    threw = true;
    assertEquals((e as Error).message.includes("scan"), true);
  }
  assertEquals(threw, true);
});

Deno.test("scan handles repo with no claude config gracefully", async () => {
  const emptyDir = new URL("testdata/empty-repo", import.meta.url).pathname;
  await Deno.mkdir(emptyDir, { recursive: true });
  try {
    const { ctx, written } = mockContext(emptyDir);
    await model.methods.scan.execute({} as Record<string, never>, ctx);
    const scan = written.get("scan") as { files: unknown[] };
    assertEquals(scan.files.length, 0);
  } finally {
    await Deno.remove(emptyDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Phase A1: parseMarkdownSections
// ---------------------------------------------------------------------------

Deno.test("parseMarkdownSections splits on headings", () => {
  const content = `# Title

Some intro text.

## Section One

Body of section one.

### Subsection

Sub body.

## Section Two

Body two.`;

  const sections = parseMarkdownSections(content);
  assertEquals(sections.length, 4);

  assertEquals(sections[0].level, 1);
  assertEquals(sections[0].heading, "Title");
  assertEquals(sections[0].body.includes("Some intro text."), true);

  assertEquals(sections[1].level, 2);
  assertEquals(sections[1].heading, "Section One");
  assertEquals(sections[1].body.includes("Body of section one."), true);

  assertEquals(sections[2].level, 3);
  assertEquals(sections[2].heading, "Subsection");

  assertEquals(sections[3].level, 2);
  assertEquals(sections[3].heading, "Section Two");
});

Deno.test("parseMarkdownSections handles preamble before first heading", () => {
  const content = `Some preamble text.

# Title

Body.`;

  const sections = parseMarkdownSections(content);
  assertEquals(sections[0].level, 0);
  assertEquals(sections[0].heading, "");
  assertEquals(sections[0].body.includes("Some preamble text."), true);

  assertEquals(sections[1].level, 1);
  assertEquals(sections[1].heading, "Title");
});

Deno.test("parseMarkdownSections handles empty content", () => {
  assertEquals(parseMarkdownSections("").length, 0);
  assertEquals(parseMarkdownSections("   ").length, 0);
});

Deno.test("parseMarkdownSections does not split headings inside code blocks", () => {
  const content = `# Title

\`\`\`bash
# this is a comment, not a heading
echo hello
\`\`\`

## Real Section

Body.`;

  const sections = parseMarkdownSections(content);
  assertEquals(sections.length, 2);
  assertEquals(sections[0].heading, "Title");
  assertEquals(sections[0].body.includes("# this is a comment"), true);
  assertEquals(sections[1].heading, "Real Section");
});

// ---------------------------------------------------------------------------
// Phase A2: extractSwampManagedSection
// ---------------------------------------------------------------------------

Deno.test("extractSwampManagedSection extracts and transforms managed block", () => {
  const content = `# Project

Some intro.

<!-- BEGIN swamp managed section — do not edit below this line -->

## Rules

1. **Search before you build.** Always search extensions first.
2. **Use the data model.** Reference with CEL.

## Skills

- \`swamp\` - Swamp CLI reference
- \`swamp-getting-started\` - Interactive onboarding

## Getting Started

Run \`swamp model search --json\` at start.

## Communication

Use \`/skill-name\` syntax for Claude Code features.

<!-- END swamp managed section -->

## Domain

Domain-specific content here.`;

  const result = extractSwampManagedSection(content);

  // Should have transformed managed content
  assertExists(result.managedContent);
  // Rules should be preserved
  assertEquals(result.managedContent.includes("Search before you build"), true);
  assertEquals(result.managedContent.includes("Use the data model"), true);
  // Getting Started should be dropped
  assertEquals(result.managedContent.includes("Getting Started"), false);
  // Communication should be dropped
  assertEquals(result.managedContent.includes("Communication"), false);
  // Skills should be transformed
  assertEquals(result.managedContent.includes("/skill-name") || false, false);

  // Remaining content should not contain the managed block
  assertEquals(result.remainingContent.includes("BEGIN swamp managed"), false);
  assertEquals(result.remainingContent.includes("Domain-specific content"), true);
  assertEquals(result.remainingContent.includes("Some intro"), true);
});

Deno.test("extractSwampManagedSection returns null when no markers", () => {
  const content = `# Project

No managed section here.`;

  const result = extractSwampManagedSection(content);
  assertEquals(result.managedContent, null);
  assertEquals(result.remainingContent, content);
});

// ---------------------------------------------------------------------------
// Phase A3: classifySection
// ---------------------------------------------------------------------------

Deno.test("classifySection drops Memory and Hooks sections", () => {
  assertEquals(classifySection({ level: 2, heading: "Memory Rules", body: "..." }), "drop");
  assertEquals(classifySection({ level: 2, heading: "Hooks", body: "..." }), "drop");
  assertEquals(classifySection({ level: 3, heading: "Pre-commit Hook", body: "Configure in .claude/settings.json." }), "drop");
});

Deno.test("classifySection transforms Git Workflow and Before Pushing", () => {
  assertEquals(
    classifySection({ level: 2, heading: "Git Workflow", body: "..." }),
    "transform",
  );
  assertEquals(
    classifySection({ level: 3, heading: "Before Pushing", body: "..." }),
    "transform",
  );
});

Deno.test("classifySection transforms sections with Claude Code references", () => {
  assertEquals(
    classifySection({
      level: 2,
      heading: "Development",
      body: 'Use `--author="Claude Code <claude-code@anthropic.com>"`',
    }),
    "transform",
  );
});

Deno.test("classifySection keeps domain sections", () => {
  assertEquals(classifySection({ level: 2, heading: "Tech Stack", body: "TypeScript" }), "keep");
  assertEquals(classifySection({ level: 2, heading: "Architecture", body: "Hexagonal" }), "keep");
  assertEquals(classifySection({ level: 2, heading: "Domain Layer", body: "Pure logic" }), "keep");
});

Deno.test("cascading drop: subsections under a dropped heading are also dropped", async () => {
  const fixture = `# Project

## Memory Rules

Memory is persistent.

### Memory Storage

Stored in ~/.claude/.

### Memory Retrieval

Retrieved on load.

## Tech Stack

TypeScript and Deno.
`;
  const tmpDir = await Deno.makeTempDir();
  const claudeMd = `${tmpDir}/CLAUDE.md`;
  await Deno.writeTextFile(claudeMd, fixture);
  try {
    const { ctx, written } = mockContext(tmpDir);
    await model.methods.scan.execute({} as Record<string, never>, ctx);
    await model.methods.generate.execute({}, ctx);
    const output = written.get("output") as { outputs: Array<{ agentsMd: string }> };
    const md = output.outputs[0].agentsMd;
    assertEquals(md.includes("Memory Rules"), false);
    assertEquals(md.includes("Memory Storage"), false);
    assertEquals(md.includes("Memory Retrieval"), false);
    assertEquals(md.includes("Tech Stack"), true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Phase A4: transformSection
// ---------------------------------------------------------------------------

Deno.test("transformSection rewrites headings", () => {
  const section: MarkdownSection = {
    level: 3,
    heading: "Before Pushing",
    body: "Run tests.",
  };
  const result = transformSection(section);
  assertEquals(result.heading, "Pre-PR Checklist");
});

Deno.test("transformSection replaces Claude Code identity references", () => {
  const section: MarkdownSection = {
    level: 2,
    heading: "Development",
    body: 'Use `--author="Claude Code <claude-code@anthropic.com>"` for commits.',
  };
  const result = transformSection(section);
  assertEquals(result.body.includes("Claude Code"), false);
  assertEquals(result.body.includes("claude-code@anthropic.com"), false);
  assertEquals(result.body.includes("the coding agent"), true);
});

Deno.test("transformSection rewrites negatives to positives", () => {
  const section: MarkdownSection = {
    level: 2,
    heading: "Git Workflow",
    body: "- **Never push directly to main** — always use a feature branch + PR\n- **Never merge PRs** — create PRs and leave merging to the user",
  };
  const result = transformSection(section);
  assertEquals(result.body.includes("Never push directly to main"), false);
  assertEquals(result.body.includes("Never merge PRs"), false);
});

Deno.test("transformSection renames Git Workflow heading", () => {
  const section: MarkdownSection = {
    level: 2,
    heading: "Git Workflow",
    body: "Some rules.",
  };
  const result = transformSection(section);
  assertEquals(result.heading, "Git Workflow Rules");
});

// ---------------------------------------------------------------------------
// Phase A5: Pipeline integration — ravegraph-like fixture
// ---------------------------------------------------------------------------

const RAVEGRAPH_PATH = new URL("testdata/ravegraph-like", import.meta.url).pathname;

Deno.test("generate with ravegraph-like repo strips Claude-specific sections", async () => {
  const { ctx, written } = mockContext(RAVEGRAPH_PATH);
  await model.methods.scan.execute({} as Record<string, never>, ctx);
  await model.methods.generate.execute({}, ctx);

  const output = written.get("output") as {
    outputs: Array<{ relativePath: string; agentsMd: string }>;
  };
  assertExists(output);
  const agentsMd = output.outputs[0].agentsMd;

  // Domain content preserved
  assertEquals(agentsMd.includes("Tech Stack"), true);
  assertEquals(agentsMd.includes("TypeScript 5.x"), true);
  assertEquals(agentsMd.includes("Repository Pattern"), true);

  // Memory and Hooks sections dropped
  assertEquals(agentsMd.includes("Memory Rules"), false);
  assertEquals(agentsMd.includes("Pre-commit Hook"), false);

  // Claude Code references removed
  assertEquals(agentsMd.includes("Claude Code"), false);
  assertEquals(agentsMd.includes("claude-code@anthropic.com"), false);
});

// ---------------------------------------------------------------------------
// Phase B: Swamp Dual-Tool Support
// ---------------------------------------------------------------------------

const PUDDLE_PATH = new URL("testdata/puddle-like", import.meta.url).pathname;

Deno.test("scan detects .swamp.yaml in swamp repos", async () => {
  const { ctx, written } = mockContext(PUDDLE_PATH);
  await model.methods.scan.execute({} as Record<string, never>, ctx);

  const scan = written.get("scan") as {
    files: Array<{ type: string; content: string }>;
  };
  const swampFile = scan.files.find((f) => f.type === "swamp_config");
  assertExists(swampFile);
  assertEquals(swampFile.content.includes("tools:"), true);
});

Deno.test("generate for swamp repo preserves transformed rules", async () => {
  const { ctx, written } = mockContext(PUDDLE_PATH);
  await model.methods.scan.execute({} as Record<string, never>, ctx);
  await model.methods.generate.execute({}, ctx);

  const output = written.get("output") as {
    outputs: Array<{ relativePath: string; agentsMd: string }>;
  };
  const agentsMd = output.outputs[0].agentsMd;

  // Swamp rules preserved
  assertEquals(agentsMd.includes("Search before you build"), true);
  assertEquals(agentsMd.includes("Use the data model"), true);

  // Domain content preserved
  assertEquals(agentsMd.includes("Data Pipeline"), true);

  // Claude-specific subsections dropped
  assertEquals(agentsMd.includes("Getting Started"), false);
  assertEquals(agentsMd.includes("Communication"), false);
});

Deno.test("generate for swamp repo prepares .swamp.yaml update", async () => {
  const { ctx, written } = mockContext(PUDDLE_PATH);
  await model.methods.scan.execute({} as Record<string, never>, ctx);
  await model.methods.generate.execute({}, ctx);

  const output = written.get("output") as {
    agentsMd: string;
    swampConfigUpdate: { tools: string[] } | null;
  };

  // Should suggest adding codex to tools
  assertExists(output.swampConfigUpdate);
  assertEquals(output.swampConfigUpdate.tools.includes("claude"), true);
  assertEquals(output.swampConfigUpdate.tools.includes("codex"), true);
});

Deno.test("generate for non-swamp repo has no swamp config update", async () => {
  const { ctx, written } = mockContext(RAVEGRAPH_PATH);
  await model.methods.scan.execute({} as Record<string, never>, ctx);
  await model.methods.generate.execute({}, ctx);

  const output = written.get("output") as {
    swampConfigUpdate: unknown;
  };
  assertEquals(output.swampConfigUpdate, null);
});

// ---------------------------------------------------------------------------
// Phase C: Recursive Subdirectory Scanning
// ---------------------------------------------------------------------------

const MULTI_PATH = new URL("testdata/multi-repo", import.meta.url).pathname;

Deno.test("walkForClaudeMd finds CLAUDE.md at multiple levels", async () => {
  const results = await walkForClaudeMd(MULTI_PATH);
  assertEquals(results.length, 2);

  const paths = results.map((r) => r.relativePath);
  assertEquals(paths.includes("CLAUDE.md"), true);
  assertEquals(paths.includes("apps/web/CLAUDE.md"), true);
});

Deno.test("walkForClaudeMd skips node_modules and .git", async () => {
  const testDir = new URL("testdata/walk-skip-test", import.meta.url).pathname;
  await Deno.mkdir(`${testDir}/node_modules`, { recursive: true });
  await Deno.mkdir(`${testDir}/.git`, { recursive: true });
  await Deno.writeTextFile(`${testDir}/CLAUDE.md`, "# Root");
  await Deno.writeTextFile(`${testDir}/node_modules/CLAUDE.md`, "# Should skip");
  await Deno.writeTextFile(`${testDir}/.git/CLAUDE.md`, "# Should skip");

  try {
    const results = await walkForClaudeMd(testDir);
    assertEquals(results.length, 1);
    assertEquals(results[0].relativePath, "CLAUDE.md");
  } finally {
    await Deno.remove(testDir, { recursive: true });
  }
});

Deno.test("generate with multi-repo produces multiple outputs", async () => {
  const { ctx, written } = mockContext(MULTI_PATH);
  await model.methods.scan.execute({} as Record<string, never>, ctx);
  await model.methods.generate.execute({}, ctx);

  const output = written.get("output") as {
    outputs: Array<{ relativePath: string; agentsMd: string }>;
  };
  assertExists(output.outputs);
  assertEquals(output.outputs.length, 2);

  const rootOutput = output.outputs.find((o) => o.relativePath === "AGENTS.md");
  assertExists(rootOutput);
  assertEquals(rootOutput.agentsMd.includes("Always run tests before committing"), true);

  const webOutput = output.outputs.find((o) => o.relativePath === "apps/web/AGENTS.md");
  assertExists(webOutput);
  assertEquals(webOutput.agentsMd.includes("Next.js App Router"), true);
});

// ---------------------------------------------------------------------------
// Phase D: Migrate convenience method
// ---------------------------------------------------------------------------

Deno.test("model has migrate method", () => {
  assertExists(model.methods.migrate);
  assertEquals(typeof model.methods.migrate.description, "string");
});

Deno.test("migrate produces same result as scan-then-generate", async () => {
  const { ctx: ctx1, written: written1 } = mockContext(FIXTURE_PATH);
  await model.methods.scan.execute({} as Record<string, never>, ctx1);
  await model.methods.generate.execute({}, ctx1);
  const separateOutput = written1.get("output") as { outputs: Array<{ agentsMd: string }> };

  const { ctx: ctx2, written: written2 } = mockContext(FIXTURE_PATH);
  await model.methods.migrate.execute({}, ctx2);
  const migrateOutput = written2.get("output") as { outputs: Array<{ agentsMd: string }> };

  assertEquals(
    separateOutput.outputs[0].agentsMd,
    migrateOutput.outputs[0].agentsMd,
  );
});

Deno.test("migrate handles empty repo", async () => {
  const emptyDir = new URL("testdata/empty-migrate", import.meta.url).pathname;
  await Deno.mkdir(emptyDir, { recursive: true });
  try {
    const { ctx, written } = mockContext(emptyDir);
    await model.methods.migrate.execute({}, ctx);
    const output = written.get("output") as { outputs: Array<{ agentsMd: string }> };
    assertExists(output);
    assertEquals(output.outputs.length, 0);
  } finally {
    await Deno.remove(emptyDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Phase E: Smoke tests against real repos (guarded by SMOKE_TEST=1)
// ---------------------------------------------------------------------------

const SMOKE = Deno.env.get("SMOKE_TEST") === "1";

Deno.test({
  name: "smoke: ravegraph (non-swamp) — no Claude refs, domain preserved",
  ignore: !SMOKE,
  async fn() {
    const repoPath = `${Deno.env.get("HOME")}/dev/rave/ravegraph`;
    const { ctx, written } = mockContext(repoPath);
    await model.methods.scan.execute({} as Record<string, never>, ctx);
    await model.methods.generate.execute({}, ctx);

    const output = written.get("output") as {
      outputs: Array<{ relativePath: string; agentsMd: string }>;
      swampConfigUpdate: unknown;
    };
    assertExists(output);
    const rootOutput = output.outputs.find((o) => o.relativePath === "AGENTS.md");
    assertExists(rootOutput);

    // No Claude Code references
    assertEquals(rootOutput.agentsMd.includes("Claude Code"), false);
    assertEquals(rootOutput.agentsMd.includes("claude-code@"), false);
    assertEquals(rootOutput.agentsMd.includes(".claude/"), false);

    // Not a swamp repo
    assertEquals(output.swampConfigUpdate, null);

    console.log("--- Ravegraph AGENTS.md preview (first 40 lines) ---");
    console.log(rootOutput.agentsMd.split("\n").slice(0, 40).join("\n"));
  },
});

Deno.test({
  name: "smoke: puddle (swamp repo) — rules preserved, Claude sections dropped",
  ignore: !SMOKE,
  async fn() {
    const repoPath = `${Deno.env.get("HOME")}/dev/puddle`;
    const { ctx, written } = mockContext(repoPath);
    await model.methods.scan.execute({} as Record<string, never>, ctx);
    await model.methods.generate.execute({}, ctx);

    const output = written.get("output") as {
      outputs: Array<{ relativePath: string; agentsMd: string }>;
      swampConfigUpdate: { tools: string[] } | null;
    };
    assertExists(output);
    const rootOutput = output.outputs.find((o) => o.relativePath === "AGENTS.md");
    assertExists(rootOutput);

    // Swamp rules should be present
    assertEquals(rootOutput.agentsMd.includes("Search before you build"), true);
    assertEquals(rootOutput.agentsMd.includes("CEL expressions"), true);

    // Claude-specific section headings should be dropped
    assertEquals(rootOutput.agentsMd.includes("Getting Started"), false);
    assertEquals(rootOutput.agentsMd.includes("## Communication"), false);

    // Should suggest adding codex
    assertExists(output.swampConfigUpdate);
    assertEquals(output.swampConfigUpdate.tools.includes("codex"), true);

    console.log("--- Puddle AGENTS.md preview (first 40 lines) ---");
    console.log(rootOutput.agentsMd.split("\n").slice(0, 40).join("\n"));
  },
});
