const FIELDS = ["model", "model_reasoning_effort", "model_context_window", "model_auto_compact_token_limit",
  "model_auto_compact_token_limit_scope", "model_post_turn_compact_threshold_percent", "model_provider", "approval_policy", "sandbox_mode",
  "web_search", "service_tier", "model_reasoning_summary"];
const ORIGINS = new Set(["packagedDefaults", "mdm", "system", "enterpriseManaged", "user", "project", "sessionFlags",
  "legacyManagedConfigTomlFromFile", "legacyManagedConfigTomlFromMdm"]);
export function safeConfig(response) {
  const fields = {};
  for (const key of FIELDS) {
    const value = response?.config?.[key];
    if (!Object.hasOwn(response?.config || {}, key)) continue;
    const scalar = value == null ? null : ["string", "number", "boolean"].includes(typeof value) ? value : "custom";
    const source = response?.origins?.[key]?.name?.type;
    fields[key] = { value: scalar, source: ORIGINS.has(source) ? source : "unknown" };
  }
  return fields;
}
