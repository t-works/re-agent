// DeepSeek Responses API config — keys come from env (export DEEPSEEK_API_KEY=...).
// Reasoning effort values: none | minimal | low | medium | high | xhigh | max
export default {
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com/responses',

  // Defaults for sub-agents and any generic reactLoop caller.
  model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
  reasoningEffort: process.env.DEEPSEEK_REASONING_EFFORT || 'none',

  // Orchestrator overrides — same value today, separate knobs for later
  // (e.g. move the orchestrator to v4-pro or higher reasoning effort without
  // touching the sub-agents' cost profile).
  orchestratorModel: process.env.DEEPSEEK_ORCHESTRATOR_MODEL || 'deepseek-v4-flash',
  // orchestratorReasoningEffort: process.env.DEEPSEEK_ORCHESTRATOR_REASONING_EFFORT || 'high',
  orchestratorReasoningEffort: 'high',

  // API-per-model cap (deepseek-v4-flash rejects > 393216 today); env-overridable
  // for models with a higher ceiling.
  maxOutputTokens: Number(process.env.DEEPSEEK_MAX_OUTPUT_TOKENS) || 393216,
  maxIterations: 130,
};
