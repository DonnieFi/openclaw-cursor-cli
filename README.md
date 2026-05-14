# openclaw-cursor-cli

An OpenClaw plugin that adds a `cursor-cli` CLI backend and provider, so OpenClaw can route model calls through the local `cursor-agent` binary (using your Cursor subscription).

**Pattern**: structurally identical to OpenClaw's built-in `claude-cli` backend — a thin wrapper that spawns the Cursor IDE's official CLI in headless `-p --output-format stream-json` mode and pipes the result back into OpenClaw.

**Highlights**

- All Cursor models (`auto`, `composer-2`, GPT-5.x, Claude 4.5/4.6/4.7, Gemini 3.x, Grok, Kimi, …) usable via `cursor-cli/<base>`.
- OpenClaw's unified `--thinking off|low|medium|high|xhigh|max` flag is translated at runtime to the corresponding Cursor model id (`-thinking-high`, `-extra-high`, etc.). Catalog stays small (~13 user-facing base ids); per-effort variants are derived.
- Model catalog and thinking-level rules are **fetched live** from `cursor-agent models` and cached — no hardcoded lists to drift when Cursor adds models.
- Single `/cursor-models refresh` slash command (in supported channels) or `bash scripts/refresh-models.sh` (shell) to re-sync after Cursor updates.

## Requirements

- OpenClaw `>= 2026.5.7`
- `cursor-agent` installed on PATH and logged in:

  ```bash
  cursor-agent login         # opens browser OAuth, once
  cursor-agent status        # should show ✓ Logged in as ...
  cursor-agent -p "say hi"   # smoke test — must return text
  ```

## Install

### Via ClawHub (recommended)

```bash
openclaw plugins install clawhub:@jeehou/openclaw-cursor-cli
```

### From a local checkout (development)

```bash
git clone https://github.com/jeehou/openclaw-cursor-cli.git
openclaw plugins install ./openclaw-cursor-cli
```

### Post-install (both routes)

```bash
# 1. Verify it loaded cleanly. Your existing default model is untouched.
openclaw plugins doctor             # "No plugin issues detected."
openclaw plugins inspect cursor-cli # cli-backend + text-inference both registered
openclaw models                     # Default unchanged

# 2. Fetch the live Cursor catalog and family rules.
bash ~/.openclaw/extensions/cursor-cli/scripts/refresh-models.sh

# 3. Allowlist the families you want to use (one entry per cursor-cli/<base>).
#    OpenClaw's agent requires explicit allowlist entries in agents.defaults.models.
openclaw config set 'agents.defaults.models["cursor-cli/auto"]' '{}'
openclaw config set 'agents.defaults.models["cursor-cli/claude-opus-4-7"]' '{}'
openclaw config set 'agents.defaults.models["cursor-cli/gpt-5.5"]' '{}'
openclaw config set 'agents.defaults.models["cursor-cli/claude-4.6-sonnet"]' '{}'
# (Use bracket notation for ids containing dots, otherwise `.` is parsed as path separator.)
```

After step 2, `openclaw models list --provider cursor-cli` shows every family with the correct context window (1024k / 256k / 195k).

## Usage

### Per-call (recommended — zero default change)

```bash
openclaw agent --local --agent main \
  --model cursor-cli/claude-opus-4-7 \
  --thinking high \
  --message "design a worker pool" \
  --json
```

The `--thinking` flag is automatically translated:

| --thinking | claude-opus-4-7 → cursor model id |
|---|---|
| off | `claude-opus-4-7-medium` |
| low | `claude-opus-4-7-thinking-low` |
| medium | `claude-opus-4-7-thinking-medium` |
| high | `claude-opus-4-7-thinking-high` |
| xhigh | `claude-opus-4-7-thinking-xhigh` |
| max | `claude-opus-4-7-thinking-max` |

(Mapping for every family is in `~/.openclaw/extensions/cursor-cli/model-rules.json` after refresh. View with `bash scripts/refresh-models.sh --dry-run` if curious.)

### Make Cursor your default

```bash
openclaw models set cursor-cli/claude-opus-4-7
# revert any time:
openclaw models set deepseek/ali-deepseek-v4-pro
```

## Refreshing when Cursor adds new models

Whenever Cursor ships new model ids, run **one** of:

**Shell**:
```bash
bash ~/.openclaw/extensions/cursor-cli/scripts/refresh-models.sh
```

**Chat slash command** (in channels that support plugin slash commands — telegram / discord / feishu / mattermost):
```
/cursor-models refresh
```

Both routes:
1. Run `cursor-agent models` and parse all 100+ Cursor model ids.
2. Group ids into families (auto, gpt-5.5, claude-opus-4-7, …) and infer per-family suffix patterns automatically.
3. Build a `thinking-level → real cursor id` mapping for each family.
4. Persist the catalog to `models.providers.cursor-cli` (your OpenClaw config).
5. Persist the family-rules cache to `~/.openclaw/extensions/cursor-cli/model-rules.json` (read by the plugin's `resolveExecutionArgs` hook at runtime).

Idempotent — re-running just updates the same files. OpenClaw backs up `openclaw.json` to `.bak` before every config write.

### Other `/cursor-models` sub-commands (slash only)

| Sub-command | Description |
|---|---|
| `/cursor-models` or `/cursor-models status` | Show cache file path, age, family count, cursor id count. |
| `/cursor-models refresh` | Re-fetch and rebuild as described above. |
| `/cursor-models list` | Print every cached family with its `off` and `high` mapping. |
| `/cursor-models help` | Show usage. |

## Plugin config (optional)

All fields are optional. Defaults preserve full agent mode (backward compatible with `0.0.1`). In `~/.openclaw/openclaw.json`:

```json5
{
  plugins: {
    entries: {
      "cursor-cli": {
        enabled: true,
        config: {
          // Path or basename of the cursor-agent binary (default: cursor-agent on PATH).
          // Only an absolute path or a simple basename like "cursor-agent" is accepted;
          // shell metacharacters (`;`, `|`, `&`, `` ` ``, `$`, `<`, `>`, …) are rejected.
          command: "/home/joe.hou/.local/bin/cursor-agent",

          // Execution mode. Pick the lowest privilege your workflow needs.
          //   "agent" (default) — full agent, can plan + edit + run shell tools
          //   "plan"            — read-only/planning, proposes diffs but never edits
          //   "ask"             — pure Q&A, no tool use at all
          mode: "agent",

          // Whether to pass --force --trust to cursor-agent.
          //   true  (default) — non-interactive headless: cursor-agent auto-approves
          //                     its own write/shell tools inside the workspace.
          //   false           — cursor-agent will refuse tool actions without an
          //                     interactive approval. Recommended for untrusted
          //                     workspaces; pair with mode:"plan" or "ask" for max safety.
          allowTools: true,

          // Optional override for cursor-agent's sandbox setting.
          //   "enabled"  — confine tool actions to a sandbox.
          //   "disabled" — opt out (cursor-agent's own default behavior).
          //   omitted    — leave it to cursor-agent's config.
          // sandbox: "enabled",

          // Advanced: extra args appended verbatim. Most users do not need this.
          extraArgs: []
        }
      }
    }
  }
}
```

### Recommended safety profiles

| Profile | Config | Effect |
| --- | --- | --- |
| **Full agent** (default) | `{}` or omit | `--force --trust`, may edit/run shell in the workspace |
| **Plan-only** | `{ mode: "plan" }` | read-only/planning, no edits even with default `allowTools: true` |
| **Read-only Q&A** | `{ mode: "ask", allowTools: false }` | pure Q&A, refuses any tool action |
| **Sandbox-enforced** | `{ sandbox: "enabled" }` | full agent but confined to cursor-agent's sandbox |

## Uninstall / Rollback

```bash
# Light: disable, keep installed
openclaw plugins disable cursor-cli

# Full uninstall
openclaw plugins uninstall cursor-cli

# Also drop the provider config + rules cache the plugin wrote:
openclaw config unset 'models.providers.cursor-cli'
rm -f ~/.openclaw/extensions/cursor-cli/model-rules.json
```

Other providers (`deepseek`, `modelhub`, `openai-codex`, …) are never touched by any of this.

## Architecture

```
openclaw agent --local --model cursor-cli/claude-opus-4-7 --thinking high --message "…"
    ↓
OpenClaw resolves model ref → provider=cursor-cli
    ↓
Routes to CLI backend "cursor-cli" (registered by this plugin)
    ↓
plugin.resolveExecutionArgs reads ~/.openclaw/extensions/cursor-cli/model-rules.json,
   looks up rules.families["claude-opus-4-7"]["high"] → "claude-opus-4-7-thinking-high"
    ↓
Spawns: cursor-agent -p --output-format stream-json --stream-partial-output \
        [--mode plan|ask]    # only if config.mode != "agent"
        [--force --trust]    # only if config.allowTools != false (default true)
        [--sandbox enabled|disabled]  # only if config.sandbox is set
        [--resume <prev-id>] "<prompt>" --model claude-opus-4-7-thinking-high
    ↓
Parses NDJSON stream via OpenClaw's claude-stream-json dialect:
   {type:"system",subtype:"init",session_id}     → session bind
   {type:"thinking",subtype:"delta",text}         → (dropped — Claude dialect doesn't know)
   {type:"assistant",message:{content:[{text}]}}  → assistant text
   {type:"result",subtype:"success",result,...}   → finalize
    ↓
Returns to OpenClaw as a normal assistant turn (session_id persisted for resume)
```

No HTTP, no OAuth, no protobuf reverse engineering. All auth, rate limiting, and billing remain with the official `cursor-agent` CLI.

## File layout

```
openclaw-cursor-cli/
├── package.json
├── openclaw.plugin.json          # manifest (id, providers, cliBackends, commandAliases)
├── index.js                      # definePluginEntry: registerCliBackend + registerProvider + registerCommand
├── src/
│   └── refresh-models.mjs        # parse cursor-agent → infer family rules → write user config + cache
├── scripts/
│   └── refresh-models.sh         # shell entry point (used by install + manual refresh)
└── README.md
```

## Limitations

- **Streaming**: uses `--output-format stream-json --stream-partial-output` and the `claude-stream-json` jsonl dialect (Cursor's NDJSON is event-compatible with Claude Code's). Multi-turn session resume via `--resume <id>` works.
- **`thinking` events from Cursor are silently dropped** by the `claude-stream-json` parser (Claude's dialect doesn't know that event type). Final `assistant` and `result` lines are parsed correctly — only intermediate reasoning text is invisible.
- **Token usage counters** are not surfaced into OpenClaw's `agentMeta.usage` under stream-json. Switch `output: "jsonl"` → `"json"` in `index.js` if you need accurate accounting.
- **`cursor-agent` runs in `--force --trust` headless mode by default**, which lets it execute its own tools (write, shell) **inside the current workspace**. Mirrors `claude-cli` behavior. For untrusted workspaces, set `config.mode: "plan"` (or `"ask"`) and/or `config.allowTools: false` — see the *Plugin config* section above for safety profiles.
- **Per-`-fast` variants** (e.g. `gpt-5.5-high-fast`) are not exposed in the catalog yet. Add a separate `--fast` flag axis if needed.
- **External plugins can't register top-level `openclaw <cmd>` CLI subcommands** in OpenClaw 2026.5.7 — that's why refreshing from the shell goes through `scripts/refresh-models.sh` rather than e.g. `openclaw cursor-models refresh`. The `/cursor-models` slash command is the in-chat equivalent.
