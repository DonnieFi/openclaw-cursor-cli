import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { readFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const BACKEND_ID = "cursor-cli";
const PROVIDER_ID = "cursor-cli";
const CURSOR_CLI_DEFAULT_COMMAND = "cursor-agent";

const RULES_CACHE_PATH = path.join(homedir(), ".openclaw", "extensions", "cursor-cli", "model-rules.json");

/**
 * Minimal fallback rules used only when the on-disk cache is missing — typically
 * because the user hasn't run `bash scripts/refresh-models.sh` yet, or after a
 * fresh `openclaw plugins install`. Covers the two Cursor models that have no
 * effort/thinking axis and are guaranteed to exist on every account.
 */
const FALLBACK_RULES = {
  version: 1,
  generatedAt: null,
  families: {
    auto: { off: "auto", minimal: "auto", low: "auto", medium: "auto", adaptive: "auto", high: "auto", xhigh: "auto", max: "auto" },
    "composer-2": { off: "composer-2", minimal: "composer-2", low: "composer-2", medium: "composer-2", adaptive: "composer-2", high: "composer-2", xhigh: "composer-2", max: "composer-2" },
  },
  knownIds: ["auto", "composer-2", "composer-2-fast"],
};

/** Read the rules cache from disk, or fall back to the minimal in-memory rules. */
function loadRules() {
  try {
    if (!existsSync(RULES_CACHE_PATH)) return { ...FALLBACK_RULES, source: "fallback (cache missing)" };
    const raw = readFileSync(RULES_CACHE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.families) {
      return { ...FALLBACK_RULES, source: "fallback (cache malformed)" };
    }
    return { ...parsed, source: RULES_CACHE_PATH };
  } catch (err) {
    return { ...FALLBACK_RULES, source: `fallback (read error: ${err.message})` };
  }
}

/**
 * Translate a user-facing model id (catalog base) + OpenClaw thinking level
 * to the real cursor-agent model id, using the on-disk rules from the latest
 * `cursor-agent models` snapshot.
 *
 * Resolution order:
 *   1. If `modelId` is a known family base, look up rules.families[modelId][level].
 *   2. If `modelId` is already a real cursor id (in knownIds), pass through.
 *   3. Otherwise pass through as-is and let cursor-agent decide (forward-compat
 *      for newly-added Cursor models the user invokes before refreshing).
 */
function resolveCursorModelId(modelId, thinkingLevel, rules) {
  const lvl = thinkingLevel ?? "off";
  const fam = rules.families?.[modelId];
  if (fam && fam[lvl]) return fam[lvl];
  return modelId;
}

const VALID_MODES = new Set(["agent", "plan", "ask"]);
const VALID_SANDBOX = new Set(["enabled", "disabled"]);

/**
 * Sanitize the `command` config value. Prevents shell-metachar injection if the
 * value somehow comes from an untrusted source — only allow an absolute path or
 * a plain command basename like `cursor-agent` / `cursor-agent-canary`.
 */
function sanitizeCommand(raw) {
  if (typeof raw !== "string") return CURSOR_CLI_DEFAULT_COMMAND;
  const trimmed = raw.trim();
  if (!trimmed) return CURSOR_CLI_DEFAULT_COMMAND;
  // Reject shell metacharacters / control chars that could be exploited if the
  // value somehow flows through a shell. spawn() itself does not invoke a shell
  // here, but defense-in-depth: keep `command` to "path-like" inputs only.
  // Note: backslash is allowed so Windows paths (C:\foo\bar.exe) work.
  if (/[;&|`$<>\n\r\t"']/.test(trimmed)) return CURSOR_CLI_DEFAULT_COMMAND;
  // Allow: absolute POSIX path, Windows drive path, or a simple basename
  // (letters/digits/underscore/dot/hyphen).
  if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed)) return trimmed;
  if (/^[A-Za-z0-9_.-]+$/.test(trimmed)) return trimmed;
  return CURSOR_CLI_DEFAULT_COMMAND;
}

/**
 * Build the `args` array passed to cursor-agent on every invocation.
 *
 * Security knobs (all configurable via plugin config — see README):
 *   - `mode: "agent"|"plan"|"ask"`  (default "agent")
 *       "plan" / "ask" route through cursor-agent's read-only execution modes.
 *   - `allowTools: boolean`         (default true)
 *       When false, omit `--force --trust` so cursor-agent will refuse to run
 *       its built-in write/shell tools without explicit approval.
 *   - `sandbox: "enabled"|"disabled"`  (optional, no flag if unset)
 *       Forwarded as `--sandbox <value>`.
 *
 * Defaults preserve backward compatibility (full agent mode with --force --trust);
 * users can opt in to safer profiles without code changes.
 */
function buildCursorArgs(pluginConfig) {
  const args = ["-p", "--output-format", "stream-json", "--stream-partial-output"];

  const mode = typeof pluginConfig?.mode === "string" ? pluginConfig.mode.toLowerCase() : "agent";
  if (VALID_MODES.has(mode) && mode !== "agent") {
    args.push("--mode", mode);
  }

  const allowTools = pluginConfig?.allowTools !== false; // default true
  if (allowTools) {
    args.push("--force", "--trust");
  }

  const sandbox = typeof pluginConfig?.sandbox === "string" ? pluginConfig.sandbox.toLowerCase() : null;
  if (sandbox && VALID_SANDBOX.has(sandbox)) {
    args.push("--sandbox", sandbox);
  }

  if (Array.isArray(pluginConfig?.extraArgs)) {
    for (const a of pluginConfig.extraArgs) {
      if (typeof a === "string" && a.length > 0) args.push(a);
    }
  }

  return args;
}

function buildCliBackend(pluginConfig) {
  const command = sanitizeCommand(pluginConfig?.command);
  const args = buildCursorArgs(pluginConfig);

  return {
    id: BACKEND_ID,
    config: {
      command,
      args,
      output: "jsonl",
      resumeOutput: "jsonl",
      jsonlDialect: "claude-stream-json",
      input: "arg",
      maxPromptArgChars: 8000,
      // NOTE: `modelArg` is intentionally NOT set here. If we set it, OpenClaw's
      // `buildCliArgs` would append `--model <context.modelId>` AFTER our
      // resolveExecutionArgs hook runs, clobbering the thinking-aware rewrite.
      // Instead, the hook below appends `--model <realId>` itself.
      sessionMode: "existing",
      sessionIdFields: ["session_id"],
      resumeArgs: ["--resume", "{sessionId}"],
      systemPromptMode: "append",
      systemPromptWhen: "first",
    },
    liveTest: {
      defaultModelRef: `${PROVIDER_ID}/auto`,
    },
    nativeToolMode: "always-on",
    resolveExecutionArgs: ({ modelId, thinkingLevel, baseArgs }) => {
      const rules = loadRules();
      const realId = resolveCursorModelId(modelId, thinkingLevel, rules);
      return [...baseArgs, "--model", realId];
    },
  };
}

/**
 * Run `bash scripts/refresh-models.sh` from the plugin's source directory and
 * stream its output back as text. Returns the final summary block.
 */
function runRefreshScript({ scriptPath, dryRun = false }) {
  return new Promise((resolve) => {
    const args = dryRun ? ["--dry-run"] : [];
    const proc = spawn("node", [scriptPath, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (b) => { stdout += b.toString(); });
    proc.stderr.on("data", (b) => { stderr += b.toString(); });
    proc.on("close", (code) => {
      resolve({ ok: code === 0, stdout, stderr, exitCode: code ?? -1 });
    });
    proc.on("error", (err) => {
      resolve({ ok: false, stdout, stderr: `${stderr}\nspawn error: ${err.message}`, exitCode: -1 });
    });
  });
}

/** Locate refresh-models.mjs relative to this plugin file. */
function getRefreshScriptPath() {
  // import.meta.url → file:///.../index.js
  const here = new URL(".", import.meta.url).pathname;
  return path.join(here, "src", "refresh-models.mjs");
}

function formatCacheStatus(rules) {
  const lines = [];
  lines.push(`Source: ${rules.source}`);
  if (rules.generatedAt) lines.push(`Last refresh: ${rules.generatedAt}`);
  const famCount = Object.keys(rules.families ?? {}).length;
  const idCount = Array.isArray(rules.knownIds) ? rules.knownIds.length : 0;
  lines.push(`Families: ${famCount}`);
  lines.push(`Cursor model ids: ${idCount}`);
  if (existsSync(RULES_CACHE_PATH)) {
    try {
      const mtime = statSync(RULES_CACHE_PATH).mtime;
      const ageMs = Date.now() - mtime.getTime();
      const ageH = (ageMs / 3_600_000).toFixed(1);
      lines.push(`File: ${RULES_CACHE_PATH} (${ageH}h old)`);
    } catch { /* ignore */ }
  } else {
    lines.push(`File: ${RULES_CACHE_PATH} (not present)`);
  }
  return lines.join("\n");
}

function formatFamilyList(rules) {
  const families = rules.families ?? {};
  const names = Object.keys(families).sort();
  if (names.length === 0) return "(no families cached — run /cursor-models refresh)";
  const lines = [];
  for (const name of names) {
    const off = families[name].off;
    const high = families[name].high;
    if (off === high) {
      lines.push(`  cursor-cli/${name}   →  ${off}`);
    } else {
      lines.push(`  cursor-cli/${name}   →  off:${off}  /  high:${high}`);
    }
  }
  return lines.join("\n");
}

export default definePluginEntry({
  id: BACKEND_ID,
  name: "Cursor CLI",
  description:
    "OpenClaw CLI backend that routes model calls through the local cursor-agent binary (Cursor subscription).",
  register(api) {
    const pluginConfig = api?.pluginConfig ?? {};

    if (typeof api.registerCliBackend === "function") {
      api.registerCliBackend(buildCliBackend(pluginConfig));
    }

    if (typeof api.registerProvider === "function") {
      api.registerProvider({
        id: PROVIDER_ID,
        label: "Cursor (CLI)",
        envVars: [],
        docsPath: "/providers/cursor-cli",
        // Catalog hook returns null because we rely on user config
        // (`models.providers.cursor-cli`) populated by refresh-models.mjs.
        catalog: {
          order: "simple",
          run: async () => null,
        },
        resolveDynamicModel: (ctx) => ({
          id: ctx.modelId,
          name: ctx.modelId,
          provider: PROVIDER_ID,
          api: "cli",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200000,
          maxTokens: 32768,
        }),
      });
    }

    // Shared command body used by both the channel slash command and the
    // top-level CLI subcommand.
    async function runCursorModelsCommand(sub) {
      const norm = (sub ?? "status").toLowerCase();
      if (norm === "help") {
        return [
          "Usage: openclaw cursor-models [status | refresh | list | help]",
          "       /cursor-models [status | refresh | list | help]   (in channel chats)",
          "",
          "  status   Show cache file path, age, family count (default).",
          "  refresh  Re-run `cursor-agent models`, rebuild family rules,",
          "           and patch models.providers.cursor-cli in your config.",
          "  list     Print every cached family and its off/high mapping.",
          "  help     Show this help.",
        ].join("\n");
      }
      if (norm === "status") return formatCacheStatus(loadRules());
      if (norm === "list") return formatFamilyList(loadRules());
      if (norm === "refresh") {
        const scriptPath = getRefreshScriptPath();
        if (!existsSync(scriptPath)) {
          return (
            `Cannot find refresh script at ${scriptPath}.\n` +
            `Re-install the plugin: openclaw plugins install <path-to-openclaw-cursor-cli>.`
          );
        }
        const result = await runRefreshScript({ scriptPath });
        const status = result.ok ? "ok" : `failed (exit ${result.exitCode})`;
        const tail = (result.stdout + result.stderr).trim().split("\n").slice(-8).join("\n");
        const rules = loadRules();
        return (
          `cursor-models refresh: ${status}\n\n${tail}\n\n` +
          `--- after refresh ---\n${formatCacheStatus(rules)}`
        );
      }
      return `Unknown sub-command: \`${norm}\`. Try \`cursor-models help\`.\n\n${formatCacheStatus(loadRules())}`;
    }

    // Channel slash command: `/cursor-models [sub]` (telegram/discord/feishu/etc.)
    // For shell users, `scripts/refresh-models.sh` is the canonical entry point —
    // OpenClaw external plugins can't register top-level `openclaw <cmd>` subcommands.
    if (typeof api.registerCommand === "function") {
      api.registerCommand({
        name: "cursor-models",
        description:
          "Inspect or refresh the cached Cursor model list and thinking-level rules. " +
          "Sub-commands: status | refresh | list | help.",
        acceptsArgs: true,
        handler: async (ctx) => {
          const tokens = (ctx?.args?.trim() ?? "").split(/\s+/).filter(Boolean);
          const text = await runCursorModelsCommand(tokens[0]);
          return { text };
        },
      });
    }
  },
});
