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
  relativePath: z.string().optional(),
  content: z.string(),
  type: z.enum([
    "claude_md",
    "settings",
    "command",
    "skill",
    "hook",
    "swamp_config",
  ]),
});

type ClaudeFile = z.infer<typeof ClaudeFileSchema>;

const OutputEntrySchema = z.object({
  relativePath: z.string(),
  agentsMd: z.string(),
});

const ScanResultSchema = z.object({
  repoPath: z.string(),
  scannedAt: z.string(),
  files: z.array(ClaudeFileSchema),
});

type ScanResult = z.infer<typeof ScanResultSchema>;

const OutputSchema = z.object({
  repoPath: z.string(),
  generatedAt: z.string(),
  outputs: z.array(OutputEntrySchema),
  sourceFiles: z.array(z.string()),
  swampConfigUpdate: z.union([
    z.object({ tools: z.array(z.string()) }),
    z.null(),
  ]),
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
// Phase A1: Section-Aware Markdown Parser
// ---------------------------------------------------------------------------

/** A parsed markdown section with its heading level, text, and body content. */
export interface MarkdownSection {
  level: number;
  heading: string;
  body: string;
}

/** Split markdown content into heading-based sections, respecting code fences. */
export function parseMarkdownSections(content: string): MarkdownSection[] {
  if (!content.trim()) return [];

  const lines = content.split("\n");
  const sections: MarkdownSection[] = [];
  let currentLevel = 0;
  let currentHeading = "";
  let bodyLines: string[] = [];
  let inCodeBlock = false;

  function flush() {
    const body = bodyLines.join("\n").trim();
    if (currentHeading || body) {
      sections.push({ level: currentLevel, heading: currentHeading, body });
    }
  }

  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      bodyLines.push(line);
      continue;
    }

    if (inCodeBlock) {
      bodyLines.push(line);
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flush();
      currentLevel = headingMatch[1].length;
      currentHeading = headingMatch[2];
      bodyLines = [];
    } else {
      bodyLines.push(line);
    }
  }

  flush();
  return sections;
}

// ---------------------------------------------------------------------------
// Phase A2: Swamp Managed Section Extraction
// ---------------------------------------------------------------------------

const SWAMP_BEGIN = /<!--\s*BEGIN\s+swamp\s+managed\s+section/i;
const SWAMP_END = /<!--\s*END\s+swamp\s+managed\s+section\s*-->/i;

const DROP_MANAGED_HEADINGS = new Set([
  "getting started",
  "communication",
]);

/** Extract the swamp-managed block, transform it (drop Claude-specific subsections), and return both parts. */
export function extractSwampManagedSection(content: string): {
  managedContent: string | null;
  remainingContent: string;
} {
  const lines = content.split("\n");
  let beginIdx = -1;
  let endIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    if (beginIdx === -1 && SWAMP_BEGIN.test(lines[i])) {
      beginIdx = i;
    }
    if (SWAMP_END.test(lines[i])) {
      endIdx = i;
    }
  }

  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) {
    return { managedContent: null, remainingContent: content };
  }

  const managedBlock = lines.slice(beginIdx + 1, endIdx).join("\n");
  const before = lines.slice(0, beginIdx).join("\n");
  const after = lines.slice(endIdx + 1).join("\n");
  const remainingContent = (before + "\n" + after).replace(/\n{3,}/g, "\n\n")
    .trim();

  const managedSections = parseMarkdownSections(managedBlock);
  const keptSections: MarkdownSection[] = [];

  for (const section of managedSections) {
    const headingLower = section.heading.toLowerCase();
    if (DROP_MANAGED_HEADINGS.has(headingLower)) continue;

    if (headingLower === "skills") {
      keptSections.push({
        level: section.level,
        heading: "Swamp CLI",
        body: "Available swamp skills: run `swamp help` for CLI discovery.",
      });
      continue;
    }

    keptSections.push(section);
  }

  const managedContent = reassembleSections(keptSections);
  return { managedContent, remainingContent };
}

// ---------------------------------------------------------------------------
// Phase A3: Section Classification
// ---------------------------------------------------------------------------

const DROP_HEADING_PATTERNS = [
  /\bmemory\b/i,
  /\bhooks?\b/i,
];

const TRANSFORM_HEADING_PATTERNS = [
  /\bgit\s+workflow\b/i,
  /\bbefore\s+pushing\b/i,
  /\bverification\b/i,
];

const CLAUDE_BODY_PATTERNS = [
  /Claude\s+Code/,
  /\.claude\//,
  /claude-code@/,
];

/** Classify a section as keep (domain), transform (rewrite refs), or drop (Claude-only). */
export function classifySection(
  section: MarkdownSection,
): "keep" | "transform" | "drop" {
  const headingLower = section.heading.toLowerCase();

  for (const pattern of DROP_HEADING_PATTERNS) {
    if (pattern.test(section.heading)) return "drop";
  }

  if (
    headingLower.includes(".claude/settings") ||
    headingLower.includes("claude code memory")
  ) {
    return "drop";
  }

  for (const pattern of TRANSFORM_HEADING_PATTERNS) {
    if (pattern.test(section.heading)) return "transform";
  }

  for (const pattern of CLAUDE_BODY_PATTERNS) {
    if (pattern.test(section.body)) return "transform";
  }

  return "keep";
}

// ---------------------------------------------------------------------------
// Phase A4: Section Transformation
// ---------------------------------------------------------------------------

const HEADING_REWRITES: Record<string, string> = {
  "before pushing": "Pre-PR Checklist",
  "git workflow": "Git Workflow Rules",
};

const NEGATIVE_REWRITES: Array<[RegExp, string]> = [
  [
    /\*\*Never push directly to main\*\*\s*(?:—|--)\s*always use a feature branch \+ PR/g,
    "**Create a branch and open a PR** — do not push directly to main",
  ],
  [
    /\*\*Never merge PRs\*\*\s*(?:—|--)\s*create PRs and leave merging to the user/g,
    "**Create PRs; leave merging to the user**",
  ],
  [
    /Never push directly to main/g,
    "Create a branch and open a PR",
  ],
  [
    /Never merge PRs/g,
    "Create PRs; leave merging to the user",
  ],
];

/** Rewrite headings, replace identity refs, and convert negatives to positives. */
export function transformSection(section: MarkdownSection): MarkdownSection {
  let heading = section.heading;
  const headingKey = heading.toLowerCase();
  if (HEADING_REWRITES[headingKey]) {
    heading = HEADING_REWRITES[headingKey];
  }

  let body = section.body;

  body = body.replace(/Claude\s+Code/g, "the coding agent");
  body = body.replace(
    /claude-code@anthropic\.com/g,
    "coding-agent@users.noreply.github.com",
  );

  for (const [pattern, replacement] of NEGATIVE_REWRITES) {
    body = body.replace(pattern, replacement);
  }

  return { level: section.level, heading, body };
}

// ---------------------------------------------------------------------------
// Reassemble sections into markdown
// ---------------------------------------------------------------------------

function reassembleSections(sections: MarkdownSection[]): string {
  const parts: string[] = [];

  for (const section of sections) {
    if (section.level === 0) {
      if (section.body) parts.push(section.body);
    } else {
      const prefix = "#".repeat(section.level);
      parts.push(`${prefix} ${section.heading}`);
      if (section.body) {
        parts.push("");
        parts.push(section.body);
      }
    }
    parts.push("");
  }

  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------------------------------------------------------------------------
// Scanner — reads Claude Code config files from a target repo
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Phase C: Recursive Subdirectory Scanning
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".swamp",
  "dist",
  "build",
  ".next",
  "out",
  "vendor",
  "__pycache__",
]);

/** Recursively find CLAUDE.md files, skipping build/vendor/dotdirs. */
export async function walkForClaudeMd(
  rootPath: string,
): Promise<Array<{ relativePath: string; content: string }>> {
  const results: Array<{ relativePath: string; content: string }> = [];

  async function walk(dir: string, relPrefix: string) {
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (entry.isFile && entry.name === "CLAUDE.md") {
          const fullPath = `${dir}/${entry.name}`;
          const content = await readFileIfExists(fullPath);
          if (content !== null) {
            const relPath = relPrefix
              ? `${relPrefix}/${entry.name}`
              : entry.name;
            results.push({ relativePath: relPath, content });
          }
        } else if (entry.isDirectory) {
          if (SKIP_DIRS.has(entry.name)) continue;
          if (entry.name.startsWith(".") && entry.name !== ".claude") continue;
          const subDir = `${dir}/${entry.name}`;
          const subPrefix = relPrefix
            ? `${relPrefix}/${entry.name}`
            : entry.name;
          await walk(subDir, subPrefix);
        }
      }
    } catch {
      // directory unreadable — skip
    }
  }

  await walk(rootPath, "");
  return results;
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

async function scanRepo(repoPath: string): Promise<ScanResult> {
  const files: ClaudeFile[] = [];

  // Walk for CLAUDE.md at all levels
  const claudeMds = await walkForClaudeMd(repoPath);
  for (const md of claudeMds) {
    files.push({
      path: `${repoPath}/${md.relativePath}`,
      relativePath: md.relativePath,
      content: md.content,
      type: "claude_md",
    });
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

  // Phase B: .swamp.yaml detection
  const swampConfig = await readFileIfExists(`${repoPath}/.swamp.yaml`);
  if (swampConfig !== null) {
    files.push({
      path: `${repoPath}/.swamp.yaml`,
      content: swampConfig,
      type: "swamp_config",
    });
  }

  return {
    repoPath,
    scannedAt: new Date().toISOString(),
    files,
  };
}

// ---------------------------------------------------------------------------
// Generator — maps Claude Code config to Codex AGENTS.md
// ---------------------------------------------------------------------------

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

function parseSwampTools(swampContent: string): string[] {
  const match = swampContent.match(/tools:\s*\n((?:\s+-\s+\S+\n?)*)/);
  if (!match) return [];
  return [...match[1].matchAll(/\s+-\s+(\S+)/g)].map((m) => m[1]);
}

function generateAgentsMdForFile(
  content: string,
  files: ClaudeFile[],
  repoPath: string,
  managedRules: string | null,
): string {
  const parts: string[] = [];
  const relPaths = files
    .filter((f) => f.type === "claude_md")
    .map((f) => f.path.replace(repoPath + "/", ""));

  parts.push("# AGENTS.md");
  parts.push("");
  parts.push(
    `> Auto-generated from project configuration (${relPaths.join(", ")}).`,
  );
  parts.push("");

  if (managedRules) {
    parts.push("## Project Rules (swamp)");
    parts.push("");
    parts.push(managedRules);
    parts.push("");
  }

  if (content.length > 0) {
    parts.push(content);
    parts.push("");
  }

  const guardrails = extractGuardrails(files);
  if (guardrails.length > 0) {
    parts.push("## Guardrails");
    parts.push("");
    for (const rule of guardrails) {
      parts.push(`- ${rule}`);
    }
    parts.push("");
  }

  const workflows = extractWorkflows(files);
  if (workflows.length > 0) {
    parts.push("## Workflows");
    parts.push("");
    parts.push(...workflows);
  }

  return parts.join("\n");
}

function generateOutputs(scan: ScanResult): {
  outputs: Array<{ relativePath: string; agentsMd: string }>;
  swampConfigUpdate: { tools: string[] } | null;
} {
  const claudeMds = scan.files.filter((f) => f.type === "claude_md");
  const outputs: Array<{ relativePath: string; agentsMd: string }> = [];

  const groupedByDir = new Map<string, ClaudeFile[]>();
  for (const f of claudeMds) {
    const rel = f.relativePath ?? f.path.replace(scan.repoPath + "/", "");
    const dir = rel === "CLAUDE.md" ? "" : rel.replace(/\/CLAUDE\.md$/, "");
    if (!groupedByDir.has(dir)) groupedByDir.set(dir, []);
    groupedByDir.get(dir)!.push(f);
  }

  for (const [dir, dirFiles] of groupedByDir) {
    const allInstructions: string[] = [];
    let managedRules: string | null = null;

    for (const f of dirFiles) {
      let content = f.content;

      const swampResult = extractSwampManagedSection(content);
      if (swampResult.managedContent) {
        managedRules = swampResult.managedContent;
        content = swampResult.remainingContent;
      }

      const sections = parseMarkdownSections(content);
      const processed: MarkdownSection[] = [];

      for (const section of sections) {
        const classification = classifySection(section);
        if (classification === "drop") continue;
        if (classification === "transform") {
          processed.push(transformSection(section));
        } else {
          processed.push(section);
        }
      }

      const result = reassembleSections(processed);
      if (result.length > 0) {
        allInstructions.push(result);
      }
    }

    const combinedInstructions = allInstructions.join("\n\n");

    const filesForGeneration = dir === "" ? scan.files : dirFiles;

    const agentsMd = generateAgentsMdForFile(
      combinedInstructions,
      filesForGeneration,
      scan.repoPath,
      dir === "" ? managedRules : null,
    );

    const relativePath = dir ? `${dir}/AGENTS.md` : "AGENTS.md";
    outputs.push({ relativePath, agentsMd });
  }

  // Phase B: swamp config update
  let swampConfigUpdate: { tools: string[] } | null = null;
  const swampFile = scan.files.find((f) => f.type === "swamp_config");
  if (swampFile) {
    const existingTools = parseSwampTools(swampFile.content);
    if (!existingTools.includes("codex")) {
      const newTools = [...existingTools];
      if (!newTools.includes("codex")) newTools.push("codex");
      swampConfigUpdate = { tools: newTools };
    }
  }

  return { outputs, swampConfigUpdate };
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

export const model = {
  type: "@mesgme/migrate-claude-to-codex" as const,
  version: "2026.09.10.2",
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
      description: "Generated AGENTS.md content and metadata.",
      schema: OutputSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    scan: {
      description: "Scan the target repo for Claude Code configuration files " +
        "(CLAUDE.md, .claude/settings.json, .claude/commands/, .claude/skills/).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ) => {
        const result = await scanRepo(context.globalArgs.repoPath);
        const handle = await context.writeResource(
          "scan",
          "scan",
          result as unknown as Record<string, unknown>,
        );
        return { dataHandles: [handle] };
      },
    },
    generate: {
      description: "Generate Codex AGENTS.md from a previous scan. " +
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
        const { outputs, swampConfigUpdate } = generateOutputs(scan);

        if (args.writeToDisk) {
          for (const entry of outputs) {
            const dir = entry.relativePath.replace(/\/[^/]+$/, "");
            if (dir !== entry.relativePath) {
              await Deno.mkdir(`${context.globalArgs.repoPath}/${dir}`, {
                recursive: true,
              });
            }
            const outPath =
              `${context.globalArgs.repoPath}/${entry.relativePath}`;
            await Deno.writeTextFile(outPath, entry.agentsMd);
          }

          if (swampConfigUpdate) {
            const swampFile = scan.files.find((f) => f.type === "swamp_config");
            if (swampFile) {
              let updatedContent = swampFile.content;
              const toolsLine = `tools:\n${
                swampConfigUpdate.tools.map((t) => `  - ${t}`).join("\n")
              }`;
              updatedContent = updatedContent.replace(
                /tools:\s*\n(?:\s+-\s+\S+\n?)*/,
                toolsLine + "\n",
              );
              await Deno.writeTextFile(
                `${context.globalArgs.repoPath}/.swamp.yaml`,
                updatedContent,
              );
            }
          }
        }

        const output = {
          repoPath: scan.repoPath,
          generatedAt: new Date().toISOString(),
          outputs,
          sourceFiles: scan.files.map((f) => f.path),
          swampConfigUpdate,
        };
        const handle = await context.writeResource(
          "output",
          "output",
          output as unknown as Record<string, unknown>,
        );
        return { dataHandles: [handle] };
      },
    },
    migrate: {
      description: "Convenience method: scan + generate in one call. " +
        "Scans the target repo and generates AGENTS.md.",
      arguments: z.object({
        writeToDisk: z.boolean().optional(),
      }),
      execute: async (
        args: { writeToDisk?: boolean },
        context: MethodContext,
      ) => {
        const scanResult = await scanRepo(context.globalArgs.repoPath);
        await context.writeResource(
          "scan",
          "scan",
          scanResult as unknown as Record<string, unknown>,
        );

        const { outputs, swampConfigUpdate } = generateOutputs(scanResult);

        if (args.writeToDisk) {
          for (const entry of outputs) {
            const dir = entry.relativePath.replace(/\/[^/]+$/, "");
            if (dir !== entry.relativePath) {
              await Deno.mkdir(`${context.globalArgs.repoPath}/${dir}`, {
                recursive: true,
              });
            }
            const outPath =
              `${context.globalArgs.repoPath}/${entry.relativePath}`;
            await Deno.writeTextFile(outPath, entry.agentsMd);
          }

          if (swampConfigUpdate) {
            const swampFile = scanResult.files.find((f) =>
              f.type === "swamp_config"
            );
            if (swampFile) {
              let updatedContent = swampFile.content;
              const toolsLine = `tools:\n${
                swampConfigUpdate.tools.map((t) => `  - ${t}`).join("\n")
              }`;
              updatedContent = updatedContent.replace(
                /tools:\s*\n(?:\s+-\s+\S+\n?)*/,
                toolsLine + "\n",
              );
              await Deno.writeTextFile(
                `${context.globalArgs.repoPath}/.swamp.yaml`,
                updatedContent,
              );
            }
          }
        }

        const output = {
          repoPath: scanResult.repoPath,
          generatedAt: new Date().toISOString(),
          outputs,
          sourceFiles: scanResult.files.map((f) => f.path),
          swampConfigUpdate,
        };
        const handle = await context.writeResource(
          "output",
          "output",
          output as unknown as Record<string, unknown>,
        );
        return {
          dataHandles: [
            { name: "scan" },
            handle,
          ],
        };
      },
    },
  },
};
