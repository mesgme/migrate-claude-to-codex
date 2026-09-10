/**
 * @mesgme/migrate-claude-to-codex — scan Claude Code config and generate Codex AGENTS.md.
 *
 * Reads a repo's Claude Code configuration (CLAUDE.md, .claude/settings.json,
 * .claude/commands/, .claude/skills/) and produces an equivalent Codex AGENTS.md
 * file that gives Codex agents the same project context and guardrails.
 *
 * @module
 */
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  repoPath: z.string().min(1),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const ClaudeFileSchema = z.object({
  path: z.string(),
  content: z.string(),
  type: z.enum(["claude_md", "settings", "command", "skill", "hook"]),
});

type ClaudeFile = z.infer<typeof ClaudeFileSchema>;

const ScanResultSchema = z.object({
  repoPath: z.string(),
  scannedAt: z.string(),
  files: z.array(ClaudeFileSchema),
});

type ScanResult = z.infer<typeof ScanResultSchema>;

const OutputSchema = z.object({
  repoPath: z.string(),
  generatedAt: z.string(),
  agentsMd: z.string(),
  sourceFiles: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// MethodContext type (minimal interface for what swamp provides)
// ---------------------------------------------------------------------------

interface MethodContext {
  globalArgs: GlobalArgs;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  readResource: (specName: string) => Promise<Record<string, unknown> | null>;
}

// ---------------------------------------------------------------------------
// Scanner — reads Claude Code config files from a target repo
// ---------------------------------------------------------------------------

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readFileIfExists(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

async function collectDir(
  dirPath: string,
  type: ClaudeFile["type"],
): Promise<ClaudeFile[]> {
  const files: ClaudeFile[] = [];
  try {
    for await (const entry of Deno.readDir(dirPath)) {
      if (!entry.isFile) continue;
      const fullPath = `${dirPath}/${entry.name}`;
      const content = await readFileIfExists(fullPath);
      if (content !== null) {
        files.push({ path: fullPath, content, type });
      }
    }
  } catch {
    // directory doesn't exist — that's fine
  }
  return files;
}

async function scanRepo(repoPath: string): Promise<ScanResult> {
  const files: ClaudeFile[] = [];

  // CLAUDE.md at repo root
  const claudeMd = await readFileIfExists(`${repoPath}/CLAUDE.md`);
  if (claudeMd !== null) {
    files.push({ path: `${repoPath}/CLAUDE.md`, content: claudeMd, type: "claude_md" });
  }

  // .claude/settings.json
  const settings = await readFileIfExists(`${repoPath}/.claude/settings.json`);
  if (settings !== null) {
    files.push({
      path: `${repoPath}/.claude/settings.json`,
      content: settings,
      type: "settings",
    });
  }

  // .claude/settings.local.json
  const localSettings = await readFileIfExists(
    `${repoPath}/.claude/settings.local.json`,
  );
  if (localSettings !== null) {
    files.push({
      path: `${repoPath}/.claude/settings.local.json`,
      content: localSettings,
      type: "settings",
    });
  }

  // .claude/commands/
  const commands = await collectDir(`${repoPath}/.claude/commands`, "command");
  files.push(...commands);

  // .claude/skills/
  const skills = await collectDir(`${repoPath}/.claude/skills`, "skill");
  files.push(...skills);

  return {
    repoPath,
    scannedAt: new Date().toISOString(),
    files,
  };
}

// ---------------------------------------------------------------------------
// Generator — maps Claude Code config to Codex AGENTS.md
//
// AGENTS.md is plain Markdown with no required structure. Codex, Cursor,
// Copilot, Windsurf, and ~30 other tools read it. Best practices:
//   - Keep the root file 20–30 lines for best agent performance
//   - Rewrite negatives as positives where possible
//   - Strip Claude-specific concepts (memory, hooks, permissions, skills)
//   - Subdirectory scoping works the same as CLAUDE.md
// ---------------------------------------------------------------------------

/** Strip lines that only make sense inside Claude Code. */
function stripClaudeSpecific(content: string): string {
  const claudePatterns = [
    /^.*\/claude\/.*settings\.json.*$/gim,
    /^.*\.claude\/commands\/.*$/gim,
    /^.*\.claude\/skills\/.*$/gim,
    /^.*slash\s+command.*$/gim,
    /^.*hook\s+script.*$/gim,
    /^.*claude\s+code\s+memory.*$/gim,
  ];

  let result = content;
  for (const pattern of claudePatterns) {
    result = result.replace(pattern, "");
  }
  return result.replace(/\n{3,}/g, "\n\n").trim();
}

function extractInstructions(files: ClaudeFile[]): string {
  const claudeMds = files.filter((f) => f.type === "claude_md");
  if (claudeMds.length === 0) return "";

  const sections = claudeMds.map((f) => stripClaudeSpecific(f.content));
  return sections.filter((s) => s.length > 0).join("\n\n");
}

function extractGuardrails(files: ClaudeFile[]): string[] {
  const rules: string[] = [];
  const settingsFiles = files.filter((f) => f.type === "settings");

  for (const f of settingsFiles) {
    try {
      const parsed = JSON.parse(f.content);
      const allowed = parsed.permissions?.allow ?? [];
      if (allowed.length > 0) {
        rules.push(`Safe to run without confirmation: ${allowed.join(", ")}`);
      }
      const denied = parsed.permissions?.deny ?? [];
      if (denied.length > 0) {
        rules.push(`Do not run: ${denied.join(", ")}`);
      }
    } catch {
      // malformed settings — skip
    }
  }

  return rules;
}

function extractWorkflows(files: ClaudeFile[]): string[] {
  const commands = files.filter((f) => f.type === "command");
  if (commands.length === 0) return [];

  const lines: string[] = [];
  for (const f of commands) {
    const name = f.path.split("/").pop()?.replace(/\.md$/, "") ?? "unknown";
    lines.push(`### ${name}`);
    lines.push("");
    lines.push(f.content.trim());
    lines.push("");
  }
  return lines;
}

function generateAgentsMd(scan: ScanResult): string {
  const parts: string[] = [];
  const relPaths = scan.files.map((f) =>
    f.path.replace(scan.repoPath + "/", "")
  );

  parts.push("# AGENTS.md");
  parts.push("");
  parts.push(
    `> Auto-generated from Claude Code configuration (${relPaths.join(", ")}).`,
  );
  parts.push("");

  // Main project instructions from CLAUDE.md
  const instructions = extractInstructions(scan.files);
  if (instructions.length > 0) {
    parts.push(instructions);
    parts.push("");
  }

  // Permissions → guardrails
  const guardrails = extractGuardrails(scan.files);
  if (guardrails.length > 0) {
    parts.push("## Guardrails");
    parts.push("");
    for (const rule of guardrails) {
      parts.push(`- ${rule}`);
    }
    parts.push("");
  }

  // Slash commands → documented workflows
  const workflows = extractWorkflows(scan.files);
  if (workflows.length > 0) {
    parts.push("## Workflows");
    parts.push("");
    parts.push(...workflows);
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

/** Model definition for migrating Claude Code config to Codex AGENTS.md. */
export const model = {
  type: "@mesgme/migrate-claude-to-codex" as const,
  version: "2026.09.10.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    scan: {
      description:
        "Scan results — all Claude Code config files found in the target repo.",
      schema: ScanResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    output: {
      description:
        "Generated AGENTS.md content and metadata.",
      schema: OutputSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    scan: {
      description:
        "Scan the target repo for Claude Code configuration files " +
        "(CLAUDE.md, .claude/settings.json, .claude/commands/, .claude/skills/).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ) => {
        const result = await scanRepo(context.globalArgs.repoPath);
        const handle = await context.writeResource("scan", "scan", result as unknown as Record<string, unknown>);
        return { dataHandles: [handle] };
      },
    },
    generate: {
      description:
        "Generate Codex AGENTS.md from a previous scan. " +
        "Requires a scan resource to exist (run the scan method first).",
      arguments: z.object({
        writeToDisk: z.boolean().optional(),
      }),
      execute: async (
        args: { writeToDisk?: boolean },
        context: MethodContext,
      ) => {
        const scanData = await context.readResource("scan");
        if (!scanData) {
          throw new Error(
            "No scan data found. Run the scan method first.",
          );
        }
        const scan = scanData as unknown as ScanResult;
        const agentsMd = generateAgentsMd(scan);

        if (args.writeToDisk) {
          const outPath = `${context.globalArgs.repoPath}/AGENTS.md`;
          await Deno.writeTextFile(outPath, agentsMd);
        }

        const output = {
          repoPath: scan.repoPath,
          generatedAt: new Date().toISOString(),
          agentsMd,
          sourceFiles: scan.files.map((f) => f.path),
        };
        const handle = await context.writeResource(
          "output",
          "output",
          output as unknown as Record<string, unknown>,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
