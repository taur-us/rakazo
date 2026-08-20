import { describe, expect, it, vi } from "vitest";
import { probeSupermemory, saveSupermemoryMemory, searchSupermemory } from "./supermemory-client.js";

const config = { baseUrl: "http://localhost:6767", apiKey: "sm_test_key" };

describe("searchSupermemory", () => {
  it("posts the query and container tag, returning search results on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ results: [{ memory: "User prefers British English", similarity: 0.9 }] }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchSupermemory("spelling preference", "rakazo:bot-123", config);

    expect(result).toEqual({
      ok: true,
      results: [{ memory: "User prefers British English", similarity: 0.9 }],
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://localhost:6767/v4/search");
    expect(init.headers.Authorization).toBe("Bearer sm_test_key");
    expect(JSON.parse(init.body)).toEqual({
      q: "spelling preference",
      containerTags: ["rakazo:bot-123"],
    });
    vi.unstubAllGlobals();
  });

  it("reports a non-OK response instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));
    const result = await searchSupermemory("anything", "rakazo:bot-123", config);
    expect(result).toEqual({ ok: false, error: expect.stringContaining("500") });
    vi.unstubAllGlobals();
  });

  it("reports an unreachable server instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")));
    const result = await searchSupermemory("anything", "rakazo:bot-123", config);
    expect(result).toEqual({ ok: false, error: expect.stringContaining("unreachable") });
    vi.unstubAllGlobals();
  });
});

describe("saveSupermemoryMemory", () => {
  it("posts the content and container tag on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await saveSupermemoryMemory("User prefers British English", "rakazo:bot-123", config);

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://localhost:6767/v4/memories");
    expect(JSON.parse(init.body)).toEqual({
      containerTag: "rakazo:bot-123",
      memories: [{ content: "User prefers British English", isStatic: false }],
    });
    vi.unstubAllGlobals();
  });

  it("reports a non-OK response instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
    const result = await saveSupermemoryMemory("fact", "rakazo:bot-123", config);
    expect(result).toEqual({ ok: false, error: expect.stringContaining("401") });
    vi.unstubAllGlobals();
  });
});

describe("probeSupermemory", () => {
  it("succeeds when the container-tags endpoint responds", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("[]", { status: 200 })));
    const result = await probeSupermemory(config);
    expect(result).toEqual({ ok: true });
    vi.unstubAllGlobals();
  });

  it("fails when the endpoint rejects the key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
    const result = await probeSupermemory(config);
    expect(result).toEqual({ ok: false, error: expect.stringContaining("401") });
    vi.unstubAllGlobals();
  });

  it("fails when nothing is listening", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")));
    const result = await probeSupermemory(config);
    expect(result).toEqual({ ok: false, error: expect.stringContaining("unreachable") });
    vi.unstubAllGlobals();
  });
});
