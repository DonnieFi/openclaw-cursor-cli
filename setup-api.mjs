/**
 * Lightweight setup hooks for the cursor-cli plugin.
 *
 * OpenClaw loads this file during its setup / doctor / config-validate flows
 * (before the heavier runtime entry in `index.js`). It is the canonical place
 * to register `PluginConfigMigration` callbacks — runtime register() does not
 * receive setup events.
 *
 * Migration scope: any user who previously installed 0.0.1 – 0.0.4 already has
 * `models.providers.cursor-cli` written by the old refresh script, but the
 * matching `agents.defaults.models` allowlist entries were never populated, so
 * `/model` could not see the models. This migration is strictly additive: for
 * each existing cursor-cli/<model-id> in the provider catalog, ensure the same
 * key appears under `agents.defaults.models`. We never remove, never overwrite.
 *
 * The migration is gated by `configContracts.compatibilityMigrationPaths`
 * (`models.providers.cursor-cli`) in `openclaw.plugin.json`, so OpenClaw only
 * loads this file if the user already has cursor-cli provider config — i.e.
 * brand-new installs do nothing here, and upgrading users get the auto-merge
 * with zero action required from them.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/core";

const PLUGIN_ID = "cursor-cli";
const PROVIDER_ID = "cursor-cli";

function migrateAllowlistFromProviderConfig(config) {
  const providerCfg = config?.models?.providers?.[PROVIDER_ID];
  const providerModels = Array.isArray(providerCfg?.models) ? providerCfg.models : [];
  if (providerModels.length === 0) return null;

  const allowlist = (config?.agents?.defaults?.models && typeof config.agents.defaults.models === "object")
    ? config.agents.defaults.models
    : {};

  const toAdd = [];
  for (const m of providerModels) {
    if (!m || typeof m.id !== "string" || !m.id) continue;
    const key = `${PROVIDER_ID}/${m.id}`;
    if (!(key in allowlist)) toAdd.push(key);
  }
  if (toAdd.length === 0) return null;

  const nextAllowlist = { ...allowlist };
  for (const k of toAdd) nextAllowlist[k] = {};

  return {
    config: {
      ...config,
      agents: {
        ...(config.agents ?? {}),
        defaults: {
          ...(config.agents?.defaults ?? {}),
          models: nextAllowlist,
        },
      },
    },
    changes: [
      `cursor-cli: added ${toAdd.length} provider model${toAdd.length === 1 ? "" : "s"} to agents.defaults.models allowlist`,
    ],
  };
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Cursor CLI Setup",
  description: "Lightweight cursor-cli setup hooks (config migrations).",
  register(api) {
    if (typeof api.registerConfigMigration === "function") {
      api.registerConfigMigration(migrateAllowlistFromProviderConfig);
    }
  },
});
