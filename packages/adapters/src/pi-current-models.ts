import type { MutableModels } from "@earendil-works/pi-ai";

/** Fill catalog gaps until the bundled provider library includes this release. */
export function supplementPiModels(models: MutableModels): MutableModels {
  if (models.getModel("openai-codex", "gpt-6.1-sol")) return models;
  const provider = models.getProvider("openai-codex");
  const base = models.getModel("openai-codex", "gpt-6-sol");
  if (!provider || !base) throw new Error("Missing model baseline: openai-codex/gpt-6-sol");
  const model = {
    ...base,
    id: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
    cost: {
      input: 2,
      output: 10,
      cacheRead: 0.1,
      cacheWrite: 2.5,
      tiers: [{ inputTokensAbove: 272000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }],
    },
    // Keep the subscription transport's window; the account catalog may narrow it.
    contextWindow: base.contextWindow,
  };
  models.setProvider({ ...provider, getModels: () => [model, ...provider.getModels()] });
  return models;
}
