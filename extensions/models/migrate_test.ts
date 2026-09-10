import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { model } from "./migrate.ts";

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
    agentsMd: string;
    sourceFiles: string[];
  };
  assertExists(output);
  assertExists(output.agentsMd);

  // should contain content from CLAUDE.md
  assertEquals(output.agentsMd.includes("Always run tests before committing"), true);
  // should contain permission guardrails
  assertEquals(output.agentsMd.includes("npm test"), true);
  // should reference the deploy workflow
  assertEquals(output.agentsMd.includes("deploy"), true);
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
