/**
 * Refresh Cursor model catalog + family rules by parsing `cursor-agent models`.
 *
 * Outputs:
 *   1. ~/.openclaw/openclaw.json  <-- patches models.providers.cursor-cli via `openclaw config set`
 *   2. ~/.openclaw/extensions/cursor-cli/model-rules.json  <-- runtime mapping for index.js
 *
 * Public API:
 *   - refreshCursorModels({ cursorAgent, openclaw, dryRun, log }) → { cache, families }
 *
 * Also runnable as a script:  node src/refresh-models.mjs
 */

// Subprocess invocation is delegated to OpenClaw's plugin-sdk run-command
// helper — the SDK-sanctioned API for plugin code. We deliberately do not
// reach for node's raw subprocess module.
//
// We load the SDK lazily so the module is parsable in two execution contexts:
//   - inside the plugin runtime, where bare specifier "openclaw/..." resolves
//     via the runtime's import hook;
//   - as a standalone CLI script invoked by scripts/refresh-models.sh, where
//     the wrapper sets OPENCLAW_RUN_COMMAND_URL to an absolute file:// URL.
import { writeFile, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

let _runPluginCommandWithTimeout = null;
async function loadRunCommand() {
  if (_runPluginCommandWithTimeout) return _runPluginCommandWithTimeout;
  const explicitUrl = process.env.OPENCLAW_RUN_COMMAND_URL;
  const mod = explicitUrl
    ? await import(explicitUrl)
    : await import("openclaw/plugin-sdk/run-command");
  if (typeof mod?.runPluginCommandWithTimeout !== "function") {
    throw new Error(
      "Could not load runPluginCommandWithTimeout from the OpenClaw plugin SDK. " +
      "Set OPENCLAW_RUN_COMMAND_URL to file:///<openclaw>/dist/plugin-sdk/run-command.js.",
    );
  }
  _runPluginCommandWithTimeout = mod.runPluginCommandWithTimeout;
  return _runPluginCommandWithTimeout;
}

export const KNOWN_EFFORT_TOKENS = ["none", "low", "medium", "high", "xhigh", "max", "extra-high"];

/** Where the runtime mapping cache lives. */
export function getRulesCachePath() {
  return path.join(homedir(), ".openclaw", "extensions", "cursor-cli", "model-rules.json");
}

/** Run a command and capture stdout; reject on non-zero exit. */
async function spawnCapture(cmd, args, { timeoutMs = 60000 } = {}) {
  const run = await loadRunCommand();
  const result = await run({ argv: [cmd, ...args], timeoutMs });
  if (result.code !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited ${result.code}\n${result.stderr}`);
  }
  return result.stdout;
}

/**
 * Parse `cursor-agent models` text output. Each useful line is:
 *   `<id> - <display_name>[ (default)]`
 */
export function parseCursorModelsOutput(output) {
  const models = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("Available models") || line.startsWith("Tip:")) continue;
    const m = line.match(/^([a-z0-9][\w.-]*)\s+-\s+(.+?)\s*$/);
    if (!m) continue;
    let displayName = m[2];
    let isDefault = false;
    if (/\s*\(default\)\s*$/i.test(displayName)) {
      isDefault = true;
      displayName = displayName.replace(/\s*\(default\)\s*$/i, "");
    }
    models.push({ id: m[1], displayName, isDefault });
  }
  return models;
}

/**
 * Decompose a single Cursor model id into (familyBase, effort, hasThinking, isFast).
 *
 * Strategies, tried in order (longest match wins):
 *   1. `<base>-thinking-<effort>[-fast]`
 *   2. `<base>-thinking[-fast]`           (e.g. claude-4.5-sonnet-thinking)
 *   3. `<base>-<effort>[-fast]`           (e.g. gpt-5.5-high)
 *   4. `<base>[-fast]`                    (e.g. composer-2)
 *
 * `<effort>` must be one of KNOWN_EFFORT_TOKENS (incl. compound "extra-high").
 * The function is intentionally tolerant: anything it can't decompose is
 * returned as a base-only model so it still appears in the catalog.
 */
export function decomposeModelId(id) {
  let rest = id;
  const isFast = rest.endsWith("-fast");
  if (isFast) rest = rest.slice(0, -"-fast".length);

  // Greedy multi-pass strip. Cursor uses BOTH orderings:
  //   `<base>-thinking-<effort>`  (Claude Opus 4.7)
  //   `<base>-<effort>-thinking`  (Claude 4.6 Sonnet)
  // and either component may appear alone. So we peel one suffix at a time
  // until none of the recognised forms match, which leaves the true family base.
  let effort = null;
  let hasThinking = false;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let stripped = false;

    // (effort-thinking) form — strip both at once
    for (const e of KNOWN_EFFORT_TOKENS) {
      const sfx = `-${e}-thinking`;
      if (rest.endsWith(sfx)) {
        rest = rest.slice(0, -sfx.length);
        if (!effort) effort = e;
        hasThinking = true;
        stripped = true;
        break;
      }
    }
    if (stripped) continue;

    // (thinking-effort) form
    for (const e of KNOWN_EFFORT_TOKENS) {
      const sfx = `-thinking-${e}`;
      if (rest.endsWith(sfx)) {
        rest = rest.slice(0, -sfx.length);
        if (!effort) effort = e;
        hasThinking = true;
        stripped = true;
        break;
      }
    }
    if (stripped) continue;

    // bare -thinking
    if (rest.endsWith("-thinking")) {
      rest = rest.slice(0, -"-thinking".length);
      hasThinking = true;
      stripped = true;
      continue;
    }

    // bare -<effort>
    for (const e of KNOWN_EFFORT_TOKENS) {
      const sfx = `-${e}`;
      if (rest.endsWith(sfx)) {
        rest = rest.slice(0, -sfx.length);
        if (!effort) effort = e;
        stripped = true;
        break;
      }
    }
    if (stripped) continue;

    break;
  }

  return { base: rest, effort, hasThinking, isFast };
}

/**
 * Build a per-family mapping from OpenClaw thinkingLevel → real Cursor model id.
 *
 * Algorithm (per family, picking from `presentIds: Set<string>`):
 *   For each OpenClaw thinking level, try a preference list of cursor variants
 *   ordered by intent, and pick the first one that actually exists.
 *
 *   Example for level=high on family `claude-opus-4-7`:
 *     try → `${base}-thinking-high` → present? use it.
 *     else → `${base}-high`         → present? use it.
 *     else → fall back through a family-shape default.
 *
 * The "intent" preference encodes:
 *   - off       → prefer no-thinking, low-effort
 *   - minimal   → prefer no-thinking, low-effort
 *   - low       → prefer thinking if thinking-low exists, else -low
 *   - medium    → prefer thinking-medium, else -medium
 *   - adaptive  → same as medium (OpenClaw's "adaptive" tracks medium-ish budget)
 *   - high      → thinking-high → -high
 *   - xhigh     → thinking-xhigh → -xhigh → -extra-high
 *   - max       → thinking-max → -max → -extra-high
 */
// Preference lists per OpenClaw thinking level. Each entry is a suffix appended
// to the family base id; we pick the first one whose composed id actually exists
// in the live cursor model list. The lists cover both Cursor suffix orderings:
//   <base>-thinking-<effort>   (Claude Opus 4.7 style)
//   <base>-<effort>-thinking   (Claude 4.6 Sonnet style)
// We deliberately prefer non-thinking ids for `off`/`minimal`/`low` so that
// "low" doesn't accidentally enable extended thinking when a non-thinking
// variant exists (e.g. claude-4.5-sonnet vs claude-4.5-sonnet-thinking).
const PREFERENCES = {
  off:      ["-low", "-none", "", "-medium",
             "-low-thinking", "-thinking-low", "-thinking"],
  minimal:  ["-low", "-none", "", "-medium",
             "-low-thinking", "-thinking-low", "-thinking"],
  low:      ["-low", "", "-medium",
             "-thinking-low", "-low-thinking", "-thinking"],
  medium:   ["-thinking-medium", "-medium-thinking", "-thinking",
             "-medium", "", "-low"],
  adaptive: ["-thinking-medium", "-medium-thinking", "-thinking",
             "-medium", "", "-low"],
  high:     ["-thinking-high", "-high-thinking", "-high",
             "-thinking-medium", "-medium-thinking", "-thinking",
             "-medium", "", "-low"],
  xhigh:    ["-thinking-xhigh", "-xhigh-thinking", "-xhigh", "-extra-high",
             "-thinking-high", "-high-thinking", "-high",
             "-thinking-medium", "-medium-thinking", "-thinking",
             "-medium", "", "-low"],
  max:      ["-thinking-max", "-max-thinking", "-max",
             "-thinking-xhigh", "-xhigh-thinking", "-xhigh", "-extra-high",
             "-thinking-high", "-high-thinking", "-high",
             "-thinking-medium", "-medium-thinking", "-thinking",
             "-medium", "", "-low"],
};

export function buildFamilyMapping(base, presentIds) {
  const mapping = {};
  for (const [level, suffixes] of Object.entries(PREFERENCES)) {
    let picked = null;
    for (const sfx of suffixes) {
      const cand = sfx === "" ? base : `${base}${sfx}`;
      if (presentIds.has(cand)) { picked = cand; break; }
    }
    // Last resort: any id in the family (any prefix-matching real id).
    if (!picked) {
      for (const id of presentIds) {
        if (id === base || id.startsWith(`${base}-`)) { picked = id; break; }
      }
    }
    mapping[level] = picked ?? base;
  }
  return mapping;
}

/**
 * Convert a model id "display name" hint into a contextWindow estimate.
 * Cursor encodes "1M" in display names for Max-Mode-capable models.
 */
function inferContextWindow(displayName) {
  if (/\b1M\b/i.test(displayName)) return 1048576;
  if (/\b256K\b/i.test(displayName)) return 262144;
  if (/\b200K\b/i.test(displayName)) return 200000;
  // Known per-family defaults
  return 200000;
}

const FAMILY_CONTEXT_HINTS = {
  // base id → contextWindow override when display name has no hint
  "gemini-3.1-pro": 1048576,
  "gemini-3-flash": 1048576,
  "grok-4.3": 262144,
  "kimi-k2.5": 262144,
  "auto": 1048576,
  "composer-2": 200000,
};

/** Build the full plugin output from a parsed model list. */
export function buildPluginPayload(models) {
  // Group by family base.
  const families = new Map(); // base → { base, ids: Set, anyDisplayName }
  const presentIds = new Set(models.map((m) => m.id));

  for (const m of models) {
    const { base } = decomposeModelId(m.id);
    if (!families.has(base)) {
      families.set(base, { base, ids: new Set(), displayHint: null });
    }
    const fam = families.get(base);
    fam.ids.add(m.id);
    // Prefer a "1M" hint for catalog contextWindow estimation.
    if (m.displayName && /\b1M\b/i.test(m.displayName)) fam.displayHint = m.displayName;
    else if (!fam.displayHint) fam.displayHint = m.displayName;
  }

  // Family rules: thinkingLevel → real Cursor id.
  // Only include non-fast ids in mapping (fast is a separate axis we don't expose yet).
  const rules = {};
  const catalogModels = [];

  for (const fam of families.values()) {
    const nonFastIds = new Set([...fam.ids].filter((id) => !id.endsWith("-fast")));
    if (nonFastIds.size === 0) continue;

    const mapping = buildFamilyMapping(fam.base, nonFastIds);
    rules[fam.base] = mapping;

    const ctxFromName = inferContextWindow(fam.displayHint ?? "");
    const ctxFromHint = FAMILY_CONTEXT_HINTS[fam.base];
    const contextWindow = Math.max(ctxFromName, ctxFromHint ?? 0) || 200000;
    const isReasoningFamily = mapping.high !== mapping.off; // family actually exposes effort axis

    catalogModels.push({
      id: fam.base,
      name: prettyFamilyName(fam.base, fam.displayHint),
      reasoning: isReasoningFamily,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens: contextWindow >= 1048576 ? 131072 : 32768,
    });
  }

  // Sort for stable output.
  catalogModels.sort((a, b) => a.id.localeCompare(b.id));

  return {
    providerConfig: {
      baseUrl: "cli://cursor-agent",
      api: "openai-completions",
      models: catalogModels,
    },
    rules: {
      version: 1,
      generatedAt: new Date().toISOString(),
      families: rules,
      // Also record the raw set so the plugin can validate user-supplied ids.
      knownIds: [...presentIds].sort(),
    },
  };
}

function prettyFamilyName(base, displayHint) {
  // Heuristic: strip trailing effort/size words from displayHint to get a clean label.
  if (!displayHint) return base;
  let s = displayHint
    .replace(/\b(High|Low|Medium|None|Extra High|Max|Thinking|Fast|1M|200K|256K)\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/\s*\(default\)\s*$/i, "")
    .trim();
  return s || base;
}

/**
 * Read the current `agents.defaults.models` allowlist via `openclaw config get`.
 * Returns an empty object if the field is missing/unparseable — never throws,
 * because losing the user's existing entries would be far worse than missing
 * a refresh.
 */
async function readAgentDefaultsModels(openclaw) {
  try {
    const raw = await spawnCapture(openclaw, ["config", "get", "agents.defaults.models"], { timeoutMs: 30000 });
    const trimmed = raw.trim();
    if (!trimmed) return {};
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    return {};
  } catch {
    return {};
  }
}

/**
 * Merge `cursor-cli/<family>` entries into `agents.defaults.models` so the
 * OpenClaw `/model` picker and agent allowlist see them after a refresh.
 *
 * Only ADDS missing entries. Never modifies entries the user (or another
 * plugin) put there, and never removes anything — even if a Cursor family
 * disappears from the upstream catalog, we leave the old entry alone so users
 * who hand-tuned it don't lose work.
 */
async function mergeAgentAllowlist({ openclaw, families, dryRun, log }) {
  const current = await readAgentDefaultsModels(openclaw);
  const toAdd = [];
  for (const fam of families) {
    const key = `cursor-cli/${fam}`;
    if (!(key in current)) toAdd.push(key);
  }
  if (toAdd.length === 0) {
    log?.(`agents.defaults.models: all ${families.length} cursor-cli families already allowlisted`);
    return;
  }
  if (dryRun) {
    log?.(`[dry-run] would add ${toAdd.length} cursor-cli entries to agents.defaults.models`);
    log?.(`           e.g. ${toAdd.slice(0, 3).join(", ")}${toAdd.length > 3 ? ", ..." : ""}`);
    return;
  }
  const next = { ...current };
  for (const k of toAdd) next[k] = {};
  await spawnCapture(openclaw, [
    "config",
    "set",
    "agents.defaults.models",
    JSON.stringify(next),
  ], { timeoutMs: 30000 });
  log?.(`agents.defaults.models: +${toAdd.length} cursor-cli entries (${Object.keys(next).length} total in allowlist)`);
}

/** Apply payload to disk + user config. */
export async function applyPayload({ payload, openclaw, dryRun, log }) {
  const rulesPath = getRulesCachePath();
  const families = payload.providerConfig.models.map((m) => m.id);

  if (dryRun) {
    log?.(`[dry-run] would write ${rulesPath}`);
    log?.(`[dry-run] would set models.providers.cursor-cli with ${families.length} models`);
    await mergeAgentAllowlist({ openclaw, families, dryRun: true, log });
    return;
  }
  await mkdir(path.dirname(rulesPath), { recursive: true });
  await writeFile(rulesPath, JSON.stringify(payload.rules, null, 2) + "\n", "utf-8");
  log?.(`wrote ${rulesPath} (${families.length} families, ${payload.rules.knownIds.length} cursor ids)`);

  await spawnCapture(openclaw, [
    "config",
    "set",
    "models.providers.cursor-cli",
    JSON.stringify(payload.providerConfig),
  ], { timeoutMs: 30000 });
  log?.(`set models.providers.cursor-cli`);

  await mergeAgentAllowlist({ openclaw, families, dryRun: false, log });
}

/** Top-level orchestration. */
export async function refreshCursorModels({ cursorAgent = "cursor-agent", openclaw = "openclaw", dryRun = false, log = console.log } = {}) {
  log(`fetching cursor-agent models...`);
  const output = await spawnCapture(cursorAgent, ["models"], { timeoutMs: 60000 });
  const models = parseCursorModelsOutput(output);
  if (models.length === 0) throw new Error("no models parsed from cursor-agent output");
  log(`parsed ${models.length} cursor models`);

  const payload = buildPluginPayload(models);
  log(`built ${payload.providerConfig.models.length} family entries`);

  await applyPayload({ payload, openclaw, dryRun, log });
  return payload;
}

/**
 * CLI entry. We compare *real* paths so symlinks like /home/foo →
 * /data00/home/foo (common on TikTok dev hosts) don't false-negative this
 * check. The original check `import.meta.url === \`file://${process.argv[1]}\``
 * worked on plain layouts but Node resolves import.meta.url through symlinks
 * while argv[1] stays as the symlinked path, so they never matched.
 *
 * Wrapped in an async IIFE so this module stays parsable by loaders that
 * don't permit top-level await (some plugin runtimes wrap ESM modules in a
 * script-style evaluator).
 */
async function isCliEntry() {
  if (!process.argv[1]) return false;
  try {
    const modulePath = fileURLToPath(import.meta.url);
    const realModulePath = await realpath(modulePath);
    const realArgvPath = await realpath(process.argv[1]);
    return realModulePath === realArgvPath;
  } catch {
    return false;
  }
}

(async () => {
  if (!(await isCliEntry())) return;
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  try {
    await refreshCursorModels({ dryRun });
    process.exit(0);
  } catch (err) {
    console.error(`refresh-models failed: ${err?.message ?? err}`);
    process.exit(1);
  }
})();
