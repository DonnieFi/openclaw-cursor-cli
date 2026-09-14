import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { readFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
// `/cursor-models refresh` invokes the refresh module directly in-process.
// All subprocess invocation lives inside src/refresh-models.mjs and is delegated
// to OpenClaw's plugin-sdk run-command helper — never node's raw subprocess API.
import { refreshCursorModels } from "./src/refresh-models.mjs";

const BACKEND_ID = "cursor-cli";
const PROVIDER_ID = "cursor-cli";
const CURSOR_CLI_DEFAULT_COMMAND = "cursor-agent";
const CURSOR_CLI_NATIVE_AUTH_MARKER = "openclaw:cursor-cli-native-auth";

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
  // value somehow flows through a shell. Subprocess invocation here does not
  // use a shell anyway, but defense-in-depth: keep `command` path-like only.
  // Note: backslash is allowed so Windows paths (C:\foo\bar.exe) work.
  if (/[;&|`$<>\n\r\t"']/.test(trimmed)) return CURSOR_CLI_DEFAULT_COMMAND;
  // Allow: absolute POSIX path, Windows drive path, or a simple basename
  // (letters/digits/underscore/dot/hyphen).
  if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed)) return trimmed;
  if (/^[A-Za-z0-9_.-]+$/.test(trimmed)) return trimmed;
  return CURSOR_CLI_DEFAULT_COMMAND;
}

/**
 * Build the args array passed to cursor-agent on every invocation. All security
 * knobs are configurable via plugin config — see the README for safety profiles.
 *
 *   - mode: "agent" | "plan" | "ask"
 *       "plan" and "ask" route cursor-agent through its read-only execution
 *       modes. The legacy headless behavior is used otherwise.
 *   - allowTools: boolean
 *       When false, the non-interactive-trust flags are omitted, so cursor-agent
 *       requires explicit approval before each tool action.
 *   - sandbox: "enabled" | "disabled"
 *       Forwarded as cursor-agent's --sandbox flag when set.
 *
 * The defaults preserve OpenClaw's standard cli-backend headless profile (matches
 * the built-in claude-cli backend); switch to the safer profiles for untrusted
 * workspaces.
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
 * Probe local `cursor-agent status --format json` without reading token material.
 * Mirrors Anthropic's Claude CLI synthetic-auth seam so Control UI catalog
 * readiness treats a logged-in Cursor subscription as available instead of
 * routing model picks into model-setup / settings.
 */
async function probeCursorCliAuthStatus({ command, signal } = {}) {
  try {
    const { runPluginCommandWithTimeout } = await import("openclaw/plugin-sdk/run-command");
    const result = await runPluginCommandWithTimeout({
      argv: [command ?? CURSOR_CLI_DEFAULT_COMMAND, "status", "--format", "json"],
      timeoutMs: 5_000,
      signal,
    });
    signal?.throwIfAborted?.();
    if (result.code !== 0) return { status: "missing" };
    const parsed = JSON.parse(String(result.stdout ?? ""));
    if (!parsed || typeof parsed !== "object") return { status: "unreadable" };
    if (parsed.isAuthenticated === true || parsed.status === "authenticated") {
      return {
        status: "available",
        email: typeof parsed.userInfo?.email === "string" ? parsed.userInfo.email : undefined,
      };
    }
    return { status: "missing" };
  } catch {
    return { status: "unreadable" };
  }
}

async function prepareCursorCliSyntheticAuth({ command, provider, signal } = {}) {
  signal?.throwIfAborted?.();
  if ((provider ?? "").toLowerCase() !== PROVIDER_ID) return undefined;
  const result = await probeCursorCliAuthStatus({
    command: sanitizeCommand(command),
    signal,
  });
  signal?.throwIfAborted?.();
  return result.status === "available"
    ? {
        apiKey: CURSOR_CLI_NATIVE_AUTH_MARKER,
        source: "Cursor CLI native auth",
        mode: "oauth",
      }
    : undefined;
}

/**
 * Drive the refresh flow in-process: calls `refreshCursorModels(...)` from
 * src/refresh-models.mjs (which delegates subprocess work to OpenClaw's
 * plugin-sdk run-command helper). Captures log lines into a buffer so the
 * slash-command handler can surface a tail of them.
 *
 * Reads optional cursor-agent / openclaw binary overrides from plugin config.
 */
async function runRefreshInProcess(pluginConfig, { dryRun = false } = {}) {
  const lines = [];
  const log = (msg) => { lines.push(String(msg)); };
  const cursorAgent = sanitizeCommand(pluginConfig?.command);
  try {
    await refreshCursorModels({ cursorAgent, dryRun, log });
    return { ok: true, lines };
  } catch (err) {
    lines.push(`refresh failed: ${err?.message ?? err}`);
    return { ok: false, lines };
  }
}

/**
 * Returns null when the cache is fine, otherwise a user-facing string
 * describing why the user should run `/cursor-models refresh`. Used by both
 * the runtime audit collector (`collectCursorCliFindings`) and the slash-
 * command status output so users see the same diagnosis no matter how they
 * arrived at it.
 */
function describeStaleCacheReason(rules) {
  if (rules.source.startsWith("fallback")) {
    return "model-rules.json is missing — using minimal fallback rules. Thinking-level rewrites will be incorrect.";
  }
  if (!rules.generatedAt) {
    return "model-rules.json predates 0.0.5 (no generatedAt). Context windows may be stale.";
  }
  const generatedAtMs = Date.parse(rules.generatedAt);
  if (!Number.isNaN(generatedAtMs)) {
    const ageDays = (Date.now() - generatedAtMs) / 86_400_000;
    if (ageDays > 30) return `model-rules.json is ${Math.floor(ageDays)} days old.`;
  }
  return null;
}

function formatCacheStatus(rules) {
  const lines = [];
  const staleReason = describeStaleCacheReason(rules);
  if (staleReason) {
    lines.push("⚠ Cache may be out of date:");
    lines.push(`  ${staleReason}`);
    lines.push("  Run `bash ~/.openclaw/extensions/cursor-cli/scripts/refresh-models.sh` to refresh.");
    lines.push("");
  }
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

/**
 * Plugin-side health collector wired into `openclaw security audit --deep`.
 *
 * NOTE: OpenClaw 2026.5.x runs audit in validate-only mode, which skips the
 * full-activation collector wiring; this collector is therefore best-effort.
 * The primary stale-cache surface is `/cursor-models status`, which formats
 * the same reason via `describeStaleCacheReason()`. We still register the
 * collector so future OpenClaw versions that invoke plugin collectors during
 * audit will automatically see the warning without code changes here.
 */
function collectCursorCliFindings() {
  const rules = loadRules();
  const reason = describeStaleCacheReason(rules);
  if (!reason) return [];
  const checkId = rules.source.startsWith("fallback")
    ? "cursor-cli.cache.missing"
    : (!rules.generatedAt ? "cursor-cli.cache.legacy" : "cursor-cli.cache.stale");
  const severity = checkId === "cursor-cli.cache.stale" ? "info" : "warn";
  return [{
    checkId,
    severity,
    title: "cursor-cli model cache needs refresh",
    detail: reason,
    remediation: "Run `bash ~/.openclaw/extensions/cursor-cli/scripts/refresh-models.sh` or `/cursor-models refresh`.",
  }];
}

export default definePluginEntry({
  id: BACKEND_ID,
  name: "Cursor CLI",
  description:
    "OpenClaw CLI backend that routes model calls through the local cursor-agent binary (Cursor subscription).",
  // Top-level so that `openclaw security audit --deep` can read the collector
  // from the plugin metadata registry without invoking the full runtime
  // register() — the audit CLI runs in its own process and only loads
  // lightweight definition fields. The upgrade-time allowlist auto-merge
  // lives in the separate setup-api.mjs file (declared by configContracts
  // in openclaw.plugin.json).
  securityAuditCollectors: [collectCursorCliFindings],
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
        prepareSyntheticAuth: (ctx) =>
          prepareCursorCliSyntheticAuth({
            ...ctx,
            command: sanitizeCommand(pluginConfig?.command),
          }),
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
        const result = await runRefreshInProcess(pluginConfig);
        const status = result.ok ? "ok" : "failed";
        const tail = result.lines.slice(-8).join("\n") || "(no output)";
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
