import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import { modelAcceptsImageInput } from "./model-vision.js";
import { PiRuntimeCredentialStore } from "./pi-credentials.js";
import { supplementPiModels } from "./pi-current-models.js";
import { listPiCatalog } from "./pi-models.js";
import { modelsForRequest, resolveRuntimeModel } from "./pi-runtime.js";

const provider = "openai-codex";
const id = "gpt-6.1-sol";
const efforts = ["low", "medium", "high", "xhigh", "max"];

describe("GPT-6.1 Sol compatibility", () => {
  it("exposes the model and supported efforts in the shared picker", () => {
    expect(
      listPiCatalog().find((entry) => entry.provider === provider && entry.id === id),
    ).toMatchObject({ label: "GPT-6.1 Sol", thinkingLevels: efforts, signIn: "device-code" });
  });

  it("resolves a runnable subscription model with image input", () => {
    const model = resolveRuntimeModel({ provider, id }).model;
    expect(model).toBeDefined();
    expect(model?.input).toContain("image");
    expect(getSupportedThinkingLevels(model!)).toEqual(efforts);
  });

  it("enables screenshot tools for the new model", () => {
    expect(modelAcceptsImageInput(provider, id)).toBe(true);
  });

  it("preserves the requesting account's OAuth credential", async () => {
    const store = new PiRuntimeCredentialStore(provider, {
      type: "oauth",
      access: "fake-account-access",
      refresh: "fake-refresh",
      expires: Date.now() + 3600000,
    });
    const models = modelsForRequest({ model: { provider, id } }, provider, store);
    expect(models.getModel(provider, id)).toBeDefined();
    expect((await models.getAuth(provider))?.auth.apiKey).toBe("fake-account-access");
  });

  it("inherits the subscription transport while supplying current pricing", () => {
    const models = supplementPiModels(builtinModels());
    const base = models.getModel(provider, "gpt-6-sol")!;
    const model = models.getModel(provider, id)!;
    expect(model.api).toBe(base.api);
    expect(model.baseUrl).toBe(base.baseUrl);
    expect(model.contextWindow).toBe(base.contextWindow);
    expect(model.maxTokens).toBe(base.maxTokens);
    expect(model.cost).toEqual({
      input: 2,
      output: 10,
      cacheRead: 0.1,
      cacheWrite: 2.5,
      tiers: [{ inputTokensAbove: 272000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }],
    });
  });

  it("is idempotent and preserves newer provider-library metadata", () => {
    const models = builtinModels();
    const originalProvider = models.getProvider(provider)!;
    const upstream = {
      ...models.getModel(provider, "gpt-6-sol")!,
      id,
      name: "Upstream model",
      contextWindow: 123456,
    };
    models.setProvider({
      ...originalProvider,
      getModels: () => [upstream, ...originalProvider.getModels()],
    });
    expect(supplementPiModels(models)).toBe(models);
    expect(supplementPiModels(models).getModel(provider, id)).toBe(upstream);
    expect(models.getModels(provider).filter((model) => model.id === id)).toHaveLength(1);
  });

  it("does not duplicate the supplemental model on repeated registration", () => {
    const models = supplementPiModels(builtinModels());
    const model = models.getModel(provider, id);
    expect(supplementPiModels(models).getModel(provider, id)).toBe(model);
    expect(models.getModels(provider).filter((entry) => entry.id === id)).toHaveLength(1);
  });
});
