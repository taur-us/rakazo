# Supermemory Memory Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a workspace connect Supermemory (cloud or an already-running local instance) as its cross-session memory backend, automatically superseding native `MEMORY.md` memory once connected, with a per-bot isolated-vs-shared scope choice.

**Architecture:** A new `WorkspaceMemoryConfig` row (workspace-scoped, credential stored via the existing `Secret`/`EncryptedSecretStore` pattern) is the on/off switch — its presence gates whether `executor.ts` offers native memory tools or Supermemory tools for that workspace's bots. A new nullable `Bot.memoryScope` picks `isolated` (today's `rakazo:<botId>` tag) or `shared` (`rakazo:workspace:<workspaceId>`), falling back to the workspace's `defaultMemoryScope`. `supermemory-client.ts` stops reading `process.env` and takes `{ baseUrl, apiKey }` as an explicit parameter.

**Tech Stack:** Prisma (schema + migration), Zod/oRPC contracts, Vitest, React (settings UI).

**Spec:** `docs/superpowers/specs/2026-08-19-supermemory-memory-mode-design.md`

## Global Constraints

- No new encryption code — credential storage goes through the existing `EncryptedSecretStore` (`packages/adapters/src/secrets.ts`) and `Secret` Prisma model, exactly as `persistModelCredential`/`resolveModelKey` already do for model credentials.
- Container tag is always computed server-side in `executor.ts` — never exposed to or settable by the agent.
- Does not touch the existing Composio-backed "Supermemory" Plugins catalog entry, and does not add auto-provisioning of a fresh local instance (spec's explicit out-of-scope list).
- Existing `supermemory-client.test.ts` behavior (request shapes, error messages) is preserved; only where `baseUrl`/`apiKey` come from changes.

---

### Task 1: Prisma schema + migration

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Create: migration under `packages/db/prisma/migrations/` (via `prisma migrate dev`)

**Interfaces:**
- Produces: `WorkspaceMemoryConfig` model (`id, workspaceId, userId, mode, baseUrl, secretId, defaultMemoryScope, createdAt, updatedAt`); `Bot.memoryScope String?`; `Organization.workspaceMemoryConfig WorkspaceMemoryConfig?`.

- [ ] **Step 1: Add the model and columns**

In `packages/db/prisma/schema.prisma`, add after `model NotificationPreference` (before `model Secret`):

```prisma
model WorkspaceMemoryConfig {
  id                 String   @id @default(cuid())
  workspaceId        String   @unique
  workspace          Organization @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  userId             String
  mode               String
  baseUrl            String
  secretId           String
  defaultMemoryScope String   @default("isolated")
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt

  @@map("workspace_memory_configs")
}
```

In `model Organization`, add alongside `notificationPreferences NotificationPreference[]`:

```prisma
  workspaceMemoryConfig WorkspaceMemoryConfig?
```

In `model Bot`, add alongside `memoryDocuments MemoryDocument[]`:

```prisma
  memoryScope String?
```

- [ ] **Step 2: Generate the migration**

Run: `cd packages/db && npx prisma migrate dev --name add_workspace_memory_config`
Expected: a new folder under `packages/db/prisma/migrations/` containing `CREATE TABLE "workspace_memory_configs"` and `ALTER TABLE "Bot" ADD COLUMN "memoryScope"`, and the dev database migrates cleanly with no errors.

- [ ] **Step 3: Regenerate the Prisma client**

Run: `cd packages/db && npx prisma generate`
Expected: exits 0; `packages/db/src/generated/prisma` picks up `WorkspaceMemoryConfig` and `Bot.memoryScope`.

- [ ] **Step 4: Commit**

```bash
git add packages/db/prisma/schema.prisma packages/db/prisma/migrations
git commit -m "Add WorkspaceMemoryConfig and Bot.memoryScope"
```

---

### Task 2: DB helpers — `findWorkspaceMemoryConfig` and `effectiveMemoryScope`

**Files:**
- Create: `packages/db/src/memory-config.ts`
- Test: `packages/db/src/memory-config.test.ts`
- Modify: `packages/db/src/index.ts` (export the new module)

**Interfaces:**
- Consumes: `PrismaClient` (from `./client.js`, same as `model-credentials.ts`).
- Produces: `findWorkspaceMemoryConfig(prisma, workspaceId): Promise<WorkspaceMemoryConfig | null>`; `effectiveMemoryScope(botScope: string | null, defaultScope: string): "isolated" | "shared"`; `supermemoryContainerTagFor(scope: "isolated" | "shared", botId: string, workspaceId: string): string`.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, it } from "vitest";
import { effectiveMemoryScope, supermemoryContainerTagFor } from "./memory-config.js";

describe("effectiveMemoryScope", () => {
  it("uses the bot's own scope when set", () => {
    expect(effectiveMemoryScope("shared", "isolated")).toBe("shared");
  });

  it("falls back to the workspace default when the bot has none", () => {
    expect(effectiveMemoryScope(null, "shared")).toBe("shared");
  });
});

describe("supermemoryContainerTagFor", () => {
  it("scopes isolated memory to the bot", () => {
    expect(supermemoryContainerTagFor("isolated", "bot-123", "ws-1")).toBe("rakazo:bot-123");
  });

  it("scopes shared memory to the workspace", () => {
    expect(supermemoryContainerTagFor("shared", "bot-123", "ws-1")).toBe("rakazo:workspace:ws-1");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/db && npx vitest run src/memory-config.test.ts`
Expected: FAIL — `memory-config.js` has no exports yet.

- [ ] **Step 3: Implement**

```typescript
import type { PrismaClient } from "./client.js";

export function findWorkspaceMemoryConfig(prisma: PrismaClient, workspaceId: string) {
  return prisma.workspaceMemoryConfig.findUnique({ where: { workspaceId } });
}

export function effectiveMemoryScope(
  botScope: string | null,
  defaultScope: string,
): "isolated" | "shared" {
  const scope = botScope ?? defaultScope;
  return scope === "shared" ? "shared" : "isolated";
}

export function supermemoryContainerTagFor(
  scope: "isolated" | "shared",
  botId: string,
  workspaceId: string,
): string {
  return scope === "shared" ? `rakazo:workspace:${workspaceId}` : `rakazo:${botId}`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/db && npx vitest run src/memory-config.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Export from the package index**

In `packages/db/src/index.ts`, add an export line for `./memory-config.js` next to the existing `./model-credentials.js` export.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/memory-config.ts packages/db/src/memory-config.test.ts packages/db/src/index.ts
git commit -m "Add workspace memory config lookup and scope resolution helpers"
```

---

### Task 3: Contracts — schemas and RPC surface

**Files:**
- Modify: `packages/contracts/src/domain.ts`
- Modify: `packages/contracts/src/rpc.ts`

**Interfaces:**
- Produces: `WorkspaceMemoryConfigSchema` (`mode: "cloud"|"local", baseUrl: string, defaultMemoryScope: "isolated"|"shared", connected: boolean, updatedAt: string`); `BotSchema.memoryScope: "isolated"|"shared"|null`; `UpdateBotInput.memoryScope?: "isolated"|"shared"|null`; RPC procedures `memory.supermemoryConfig.get`, `memory.supermemoryConfig.connect`, `memory.supermemoryConfig.disconnect`.

- [ ] **Step 1: Add `WorkspaceMemoryConfigSchema` to domain.ts**

In `packages/contracts/src/domain.ts`, add near `ModelCredentialSchema`:

```typescript
export const MemoryScopeSchema = z.enum(["isolated", "shared"]);
export type MemoryScopeValue = z.infer<typeof MemoryScopeSchema>;

export const WorkspaceMemoryConfigSchema = z.object({
  mode: z.enum(["cloud", "local"]),
  baseUrl: z.string(),
  defaultMemoryScope: MemoryScopeSchema,
  connected: z.boolean(),
  updatedAt: z.string(),
});
export type WorkspaceMemoryConfig = z.infer<typeof WorkspaceMemoryConfigSchema>;
```

Note: `WorkspaceMemoryConfigSchema` never includes `secretId` or the plaintext key — mirrors `ModelCredentialSchema.hasKey` in never exposing the underlying credential.

- [ ] **Step 2: Add `memoryScope` to `BotSchema` and `UpdateBotInput`**

In `BotSchema` (`domain.ts`), add after `parentBotId: Id.nullable(),`:

```typescript
  memoryScope: MemoryScopeSchema.nullable(),
```

In `UpdateBotInput`, add after `pinned: z.boolean().optional(),`:

```typescript
  memoryScope: MemoryScopeSchema.nullable().optional(),
```

- [ ] **Step 3: Extend the `memory` namespace in rpc.ts**

Import `WorkspaceMemoryConfigSchema` and `MemoryScopeSchema` in `packages/contracts/src/rpc.ts`, then extend the existing `memory: { ... }` block:

```typescript
  memory: {
    list: oc
      .input(z.object({ botId: Id.optional(), scope: z.enum(["bot", "user"]).optional() }))
      .output(z.array(MemoryDocumentSchema)),
    update: oc
      .input(z.object({ documentId: Id, content: z.string() }))
      .output(MemoryDocumentSchema),
    exportMarkdown: oc.input(z.object({ botId: Id.optional() })).output(z.string()),
    supermemoryConfig: oc.output(WorkspaceMemoryConfigSchema.nullable()),
    connectSupermemory: oc
      .input(
        z.object({
          mode: z.enum(["cloud", "local"]),
          apiKey: z.string().min(8),
          baseUrl: z.string().url().optional(),
          defaultMemoryScope: MemoryScopeSchema.default("isolated"),
        }),
      )
      .output(WorkspaceMemoryConfigSchema),
    disconnectSupermemory: oc.output(z.object({ ok: z.literal(true) })),
  },
```

(`baseUrl` optional because `mode: "cloud"` always resolves to `https://api.supermemory.ai` server-side; `mode: "local"` requires it and the handler validates that in Task 5.)

- [ ] **Step 4: Typecheck the contracts package**

Run: `cd packages/contracts && npx tsc --noEmit -p tsconfig.json`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/domain.ts packages/contracts/src/rpc.ts
git commit -m "Add Supermemory workspace config and per-bot memory scope to contracts"
```

---

### Task 4: `supermemory-client.ts` — explicit config, scope-aware tags

**Files:**
- Modify: `packages/adapters/src/supermemory-client.ts`
- Modify: `packages/adapters/src/supermemory-client.test.ts`

**Interfaces:**
- Consumes: `supermemoryContainerTagFor` from `@rakazo/db` (Task 2).
- Produces: `searchSupermemory(query: string, containerTag: string, config: { baseUrl: string; apiKey: string }): Promise<SupermemorySearchResponse>`; `saveSupermemoryMemory(content: string, containerTag: string, config: { baseUrl: string; apiKey: string }): Promise<SupermemorySaveResponse>`; `probeSupermemory(config: { baseUrl: string; apiKey: string }): Promise<{ ok: true } | { ok: false; error: string }>`.
- Removes: `supermemoryConfig()` (the `process.env`-reading function) and the `"not configured"` branch in both functions — config is now a required parameter, so "unconfigured" can no longer occur inside this module. `supermemoryContainerTag(botId)` (the old fixed-isolation helper) is removed; callers use `supermemoryContainerTagFor` from `@rakazo/db` instead.

- [ ] **Step 1: Write the failing tests (replacing the env-var-based ones)**

Replace the full contents of `packages/adapters/src/supermemory-client.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/adapters && npx vitest run src/supermemory-client.test.ts`
Expected: FAIL — `probeSupermemory` doesn't exist; `searchSupermemory`/`saveSupermemoryMemory` don't accept a third argument yet.

- [ ] **Step 3: Implement**

Replace `packages/adapters/src/supermemory-client.ts` in full:

```typescript
const SUPERMEMORY_TIMEOUT_MS = 15_000;

export interface SupermemoryResult {
  memory: string;
  similarity: number;
  updatedAt?: string;
}

export type SupermemorySearchResponse =
  | { ok: true; results: SupermemoryResult[] }
  | { ok: false; error: string };

export type SupermemorySaveResponse = { ok: true } | { ok: false; error: string };
export type SupermemoryProbeResponse = { ok: true } | { ok: false; error: string };

export interface SupermemoryConnectionConfig {
  baseUrl: string;
  apiKey: string;
}

function unreachableError(error: unknown): string {
  return `Supermemory is unreachable: ${error instanceof Error ? error.message : String(error)}`;
}

function authHeaders(config: SupermemoryConnectionConfig): HeadersInit {
  return { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" };
}

export async function searchSupermemory(
  query: string,
  containerTag: string,
  config: SupermemoryConnectionConfig,
): Promise<SupermemorySearchResponse> {
  try {
    const response = await fetch(`${config.baseUrl}/v4/search`, {
      method: "POST",
      headers: authHeaders(config),
      body: JSON.stringify({ q: query, containerTags: [containerTag] }),
      signal: AbortSignal.timeout(SUPERMEMORY_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { ok: false, error: `Supermemory search failed: ${response.status}` };
    }
    const data = (await response.json()) as { results?: SupermemoryResult[] };
    return { ok: true, results: data.results ?? [] };
  } catch (error) {
    return { ok: false, error: unreachableError(error) };
  }
}

export async function saveSupermemoryMemory(
  content: string,
  containerTag: string,
  config: SupermemoryConnectionConfig,
): Promise<SupermemorySaveResponse> {
  try {
    const response = await fetch(`${config.baseUrl}/v4/memories`, {
      method: "POST",
      headers: authHeaders(config),
      body: JSON.stringify({ containerTag, memories: [{ content, isStatic: false }] }),
      signal: AbortSignal.timeout(SUPERMEMORY_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { ok: false, error: `Supermemory save failed: ${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: unreachableError(error) };
  }
}

export async function probeSupermemory(
  config: SupermemoryConnectionConfig,
): Promise<SupermemoryProbeResponse> {
  try {
    const response = await fetch(`${config.baseUrl}/v3/container-tags/list`, {
      method: "GET",
      headers: authHeaders(config),
      signal: AbortSignal.timeout(SUPERMEMORY_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { ok: false, error: `Supermemory rejected the connection: ${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: unreachableError(error) };
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/adapters && npx vitest run src/supermemory-client.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Fix callers broken by the signature change**

Run: `cd packages/adapters && npx tsc --noEmit -p tsconfig.json`
Expected: FAIL, pointing at `executor.ts`'s two call sites (`searchSupermemory`/`saveSupermemoryMemory` calls, and the `supermemoryContainerTag` import) — these are fixed in Task 6, not here. Confirm the only errors are in `executor.ts` before moving on (nothing else in the package references the old signature).

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/src/supermemory-client.ts packages/adapters/src/supermemory-client.test.ts
git commit -m "Make supermemory-client take connection config explicitly instead of reading env vars"
```

---

### Task 5: Router — persist and resolve `WorkspaceMemoryConfig`

**Files:**
- Modify: `apps/api/src/router.ts`
- Test: `apps/api/src/persist-supermemory-config.test.ts`

**Interfaces:**
- Consumes: `probeSupermemory` (Task 4), `findWorkspaceMemoryConfig` (Task 2), `deps.secrets.put`/`deps.prisma.secret`, `deps.prisma.workspaceMemoryConfig`.
- Produces: `persistSupermemoryConfig(deps, actor, input): Promise<WorkspaceMemoryConfig>` (contracts type, exported from `router.ts` for direct testing); wires `memory.supermemoryConfig`, `memory.connectSupermemory`, `memory.disconnectSupermemory`.

Add `findWorkspaceMemoryConfig` to the existing `@rakazo/db` import block in `router.ts` (the one ending `} from "@rakazo/db";` around line 61).

Note on testing approach: this codebase has no `router.test.ts` and no oRPC-caller-based integration test harness (confirmed — `find apps/api/src -iname "router*.test.ts"` returns nothing). The established pattern for testing router-adjacent logic (`packages/db/src/model-credentials.test.ts`) is a direct unit test of an exported plain function with hand-mocked `prisma`/deps via `vi.fn()`. `persistSupermemoryConfig` is exported specifically so it can be tested this way, same as it would be called from the `connectSupermemory` handler.

- [ ] **Step 1: Write the failing unit test**

Create `apps/api/src/persist-supermemory-config.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { persistSupermemoryConfig } from "./router.js";

const actor = { userId: "user-1", workspaceId: "ws-1", email: "a@b.com", isDeploymentOwner: false };

function makeDeps(overrides: {
  existing?: { id: string; secretId: string } | null;
  upsertResult?: { mode: string; baseUrl: string; defaultMemoryScope: string; updatedAt: Date };
} = {}) {
  const secretCreate = vi.fn().mockResolvedValue({ id: "secret-new" });
  const secretDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
  const findUnique = vi.fn().mockResolvedValue(overrides.existing ?? null);
  const upsert = vi.fn().mockResolvedValue(
    overrides.upsertResult ?? {
      mode: "cloud",
      baseUrl: "https://api.supermemory.ai",
      defaultMemoryScope: "isolated",
      updatedAt: new Date("2026-08-19T00:00:00.000Z"),
    },
  );
  const deps = {
    prisma: {
      workspaceMemoryConfig: { findUnique, upsert },
      secret: { create: secretCreate, deleteMany: secretDeleteMany },
    },
    secrets: { put: vi.fn().mockResolvedValue({ id: "secret-new", ciphertext: "cipher" }) },
  };
  return { deps, secretCreate, secretDeleteMany, findUnique, upsert };
}

describe("persistSupermemoryConfig", () => {
  it("rejects local mode without a baseUrl, without touching the database", async () => {
    const { deps, upsert } = makeDeps();
    await expect(
      persistSupermemoryConfig(deps as never, actor, {
        mode: "local",
        apiKey: "sm_test_key_12345",
        defaultMemoryScope: "isolated",
      }),
    ).rejects.toThrow(/baseUrl/);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("probes before persisting, and rejects (without writing) when the probe fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
    const { deps, upsert } = makeDeps();
    await expect(
      persistSupermemoryConfig(deps as never, actor, {
        mode: "local",
        apiKey: "sm_bad_key",
        baseUrl: "http://localhost:6767",
        defaultMemoryScope: "isolated",
      }),
    ).rejects.toThrow();
    expect(upsert).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("connects cloud mode, defaulting the base URL, and returns the serialized config", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("[]", { status: 200 })));
    const { deps, upsert } = makeDeps();
    const result = await persistSupermemoryConfig(deps as never, actor, {
      mode: "cloud",
      apiKey: "sm_test_key_12345",
      defaultMemoryScope: "isolated",
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: "ws-1" },
        create: expect.objectContaining({ mode: "cloud", baseUrl: "https://api.supermemory.ai" }),
      }),
    );
    expect(result).toEqual({
      mode: "cloud",
      baseUrl: "https://api.supermemory.ai",
      defaultMemoryScope: "isolated",
      connected: true,
      updatedAt: "2026-08-19T00:00:00.000Z",
    });
    vi.unstubAllGlobals();
  });

  it("deletes the old secret when replacing an existing config with a new key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("[]", { status: 200 })));
    const { deps, secretDeleteMany } = makeDeps({ existing: { id: "cfg-1", secretId: "secret-old" } });
    await persistSupermemoryConfig(deps as never, actor, {
      mode: "cloud",
      apiKey: "sm_new_key_12345",
      defaultMemoryScope: "isolated",
    });
    expect(secretDeleteMany).toHaveBeenCalledWith({ where: { id: "secret-old" } });
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/persist-supermemory-config.test.ts`
Expected: FAIL — `persistSupermemoryConfig` is not exported from `router.ts` yet (and doesn't exist).

- [ ] **Step 3: Implement `persistSupermemoryConfig` and the handlers**

In `apps/api/src/router.ts`, add near `persistModelCredential`:

```typescript
const SUPERMEMORY_CLOUD_BASE_URL = "https://api.supermemory.ai";

export async function persistSupermemoryConfig(
  deps: RouterDeps,
  actor: Actor,
  input: {
    mode: "cloud" | "local";
    apiKey: string;
    baseUrl?: string;
    defaultMemoryScope: "isolated" | "shared";
  },
) {
  if (input.mode === "local" && !input.baseUrl) {
    throw new ORPCError("BAD_REQUEST", { message: "baseUrl is required for local mode" });
  }
  const baseUrl = input.mode === "cloud" ? SUPERMEMORY_CLOUD_BASE_URL : input.baseUrl!;
  const probe = await probeSupermemory({ baseUrl, apiKey: input.apiKey });
  if (!probe.ok) {
    throw new ORPCError("BAD_REQUEST", { message: probe.error });
  }
  const stored = await deps.secrets.put(input.apiKey, {
    operationId: "supermemory-config",
    traceId: "supermemory-config",
    workspaceId: actor.workspaceId,
    userId: actor.userId,
    signal: new AbortController().signal,
  });
  const existing = await findWorkspaceMemoryConfig(deps.prisma, actor.workspaceId);
  const secret = await deps.prisma.secret.create({
    data: {
      id: stored.id,
      userId: actor.userId,
      workspaceId: actor.workspaceId,
      kind: "supermemory",
      ciphertext: stored.ciphertext,
    },
  });
  const config = await deps.prisma.workspaceMemoryConfig.upsert({
    where: { workspaceId: actor.workspaceId },
    create: {
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      mode: input.mode,
      baseUrl,
      secretId: secret.id,
      defaultMemoryScope: input.defaultMemoryScope,
    },
    update: {
      mode: input.mode,
      baseUrl,
      secretId: secret.id,
      defaultMemoryScope: input.defaultMemoryScope,
    },
  });
  if (existing && existing.secretId !== secret.id) {
    await deps.prisma.secret.deleteMany({ where: { id: existing.secretId } });
  }
  return serializeWorkspaceMemoryConfig(config, true);
}

function serializeWorkspaceMemoryConfig(
  config: { mode: string; baseUrl: string; defaultMemoryScope: string; updatedAt: Date },
  connected: boolean,
) {
  return {
    mode: config.mode as "cloud" | "local",
    baseUrl: config.baseUrl,
    defaultMemoryScope: config.defaultMemoryScope as "isolated" | "shared",
    connected,
    updatedAt: config.updatedAt.toISOString(),
  };
}
```

In the `memory: { ... }` handler block (near the existing `memory.list`/`memory.update` handlers), add:

```typescript
      supermemoryConfig: authed.memory.supermemoryConfig.handler(async ({ context }) => {
        const config = await findWorkspaceMemoryConfig(deps.prisma, context.actor.workspaceId);
        return config ? serializeWorkspaceMemoryConfig(config, true) : null;
      }),
      connectSupermemory: authed.memory.connectSupermemory.handler(async ({ context, input }) =>
        persistSupermemoryConfig(deps, context.actor, input),
      ),
      disconnectSupermemory: authed.memory.disconnectSupermemory.handler(async ({ context }) => {
        const existing = await findWorkspaceMemoryConfig(deps.prisma, context.actor.workspaceId);
        if (existing) {
          await deps.prisma.workspaceMemoryConfig.delete({ where: { id: existing.id } });
          await deps.prisma.secret.deleteMany({ where: { id: existing.secretId } });
        }
        return { ok: true as const };
      }),
```

`packages/adapters/src/index.ts` doesn't currently re-export `supermemory-client.ts` at all (confirmed — it's only used internally via relative import in `executor.ts` today). Add this line to `packages/adapters/src/index.ts`:

```typescript
export { probeSupermemory } from "./supermemory-client.js";
```

Then in `apps/api/src/router.ts`, add `probeSupermemory` to the existing import block from `"@rakazo/adapters"` (the one ending `} from "@rakazo/adapters";` around line 41).

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/persist-supermemory-config.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Full package typecheck**

Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/router.ts apps/api/src/persist-supermemory-config.test.ts packages/adapters/src/index.ts
git commit -m "Add memory.connectSupermemory/supermemoryConfig/disconnectSupermemory endpoints"
```

---

### Task 6: Router — `bots.update` and bot serialization carry `memoryScope`

**Files:**
- Modify: `packages/db/src/repos.ts` (`mapBot` input type + output)
- Test: `packages/db/src/repos.test.ts` (new file — none exists yet for `repos.ts`)
- Modify: `apps/api/src/router.ts` (`bots.update` handler)

**Interfaces:**
- Consumes: `Bot.memoryScope` (Task 1).
- Produces: `mapBot(...)` output includes `memoryScope`; `bots.update` persists it.

There's no existing test file for `repos.ts` either. `mapBot` is already a small, pure, exported-from-module function taking a plain object and returning a plain object — test it directly, same reasoning as Task 5.

- [ ] **Step 1: Write the failing test**

`mapBot` isn't currently exported. First, in `packages/db/src/repos.ts`, change `function mapBot(` to `export function mapBot(`.

Create `packages/db/src/repos.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { mapBot } from "./repos.js";

const baseBot = {
  id: "bot-1",
  workspaceId: "ws-1",
  name: "Test Bot",
  title: "",
  description: "",
  instructions: "",
  color: "#000",
  notifyOnFinish: true,
  pinned: false,
  archivedAt: null,
  parentBotId: null,
  memoryScope: null as string | null,
  createdAt: new Date("2026-08-19T00:00:00.000Z"),
  updatedAt: new Date("2026-08-19T00:00:00.000Z"),
  thread: { id: "thread-1", unread: false },
  computer: null,
};

describe("mapBot", () => {
  it("passes memoryScope through as null when unset", () => {
    expect(mapBot(baseBot).memoryScope).toBeNull();
  });

  it("passes memoryScope through when set to shared", () => {
    expect(mapBot({ ...baseBot, memoryScope: "shared" }).memoryScope).toBe("shared");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/db && npx vitest run src/repos.test.ts`
Expected: FAIL — `mapBot`'s parameter type has no `memoryScope` field and its return object doesn't include one (TS error and/or `undefined` result).

- [ ] **Step 3: Implement**

In `packages/db/src/repos.ts`, add `memoryScope: string | null;` to `mapBot`'s parameter type (next to the existing `parentBotId: string | null;` line), and add `memoryScope: bot.memoryScope,` to its returned object (next to the existing `parentBotId: bot.parentBotId,` line).

In `apps/api/src/router.ts`, in the `bots.update` handler's `data:` object (the `deps.prisma.bot.update` call), add:

```typescript
            memoryScope: input.memoryScope,
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/db && npx vitest run src/repos.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Typecheck**

Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/repos.ts packages/db/src/repos.test.ts apps/api/src/router.ts
git commit -m "Carry Bot.memoryScope through bots.update and bot serialization"
```

---

### Task 7: Executor — gate memory tools and resolve scope-aware container tags

**Files:**
- Create: `packages/adapters/src/memory-tools.ts`
- Test: `packages/adapters/src/memory-tools.test.ts`
- Modify: `packages/adapters/src/executor.ts`

**Interfaces:**
- Consumes: `findWorkspaceMemoryConfig`, `effectiveMemoryScope`, `supermemoryContainerTagFor` (Task 2); `probeSupermemory`-free `searchSupermemory`/`saveSupermemoryMemory(query, tag, config)` (Task 4); `ConnectorTool` (from `@rakazo/adapter-kit`, already used by `builtin-tools.ts`).
- Produces: `selectMemoryTools(tools: ConnectorTool[], supermemoryConfigured: boolean): ConnectorTool[]` — a pure function, independently testable without touching `executor.ts`'s much larger, currently-untested `runAttempt` orchestration.

There's no `executor.test.ts` in this codebase — `executor.ts`'s ~1800-line `runAttempt` is not unit tested directly anywhere; the parts of its behavior that ARE unit tested (e.g. `memory-context.ts`, tested by `memory-context.test.ts`) were each pulled out into their own small module first, same pattern as `model-credentials.ts`. This task follows that precedent: extract the one genuinely new decision this feature adds — which memory tools a bot gets — into its own pure function and test it directly. The surrounding wiring in `executor.ts` (fetching the config, decrypting the secret, calling `selectMemoryTools`, and passing the resolved container tag into the two tool handlers) is orchestration glue with no existing test coverage precedent to extend; it's verified by the manual dev-stack check in Task 9, matching how the rest of `runAttempt`'s untested wiring is verified today.

- [ ] **Step 1: Write the failing test**

Create `packages/adapters/src/memory-tools.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { ConnectorTool } from "@rakazo/adapter-kit";
import { selectMemoryTools } from "./memory-tools.js";

function tool(name: string): ConnectorTool {
  return { name, description: name, inputSchema: { type: "object", properties: {} } };
}

const allThree = [tool("remember"), tool("recall_memory"), tool("save_memory"), tool("shell")];

describe("selectMemoryTools", () => {
  it("keeps native remember and drops Supermemory tools when unconfigured", () => {
    const names = selectMemoryTools(allThree, false).map((t) => t.name);
    expect(names).toEqual(["remember", "shell"]);
  });

  it("keeps Supermemory tools and drops native remember when configured", () => {
    const names = selectMemoryTools(allThree, true).map((t) => t.name);
    expect(names).toEqual(["recall_memory", "save_memory", "shell"]);
  });

  it("is a no-op for tool lists with no memory tools at all", () => {
    const shellOnly = [tool("shell")];
    expect(selectMemoryTools(shellOnly, false)).toEqual(shellOnly);
    expect(selectMemoryTools(shellOnly, true)).toEqual(shellOnly);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/adapters && npx vitest run src/memory-tools.test.ts`
Expected: FAIL — `./memory-tools.js` doesn't exist.

- [ ] **Step 3: Implement**

Create `packages/adapters/src/memory-tools.ts`:

```typescript
import type { ConnectorTool } from "@rakazo/adapter-kit";

const SUPERMEMORY_TOOL_NAMES = new Set(["recall_memory", "save_memory"]);

export function selectMemoryTools(
  tools: ConnectorTool[],
  supermemoryConfigured: boolean,
): ConnectorTool[] {
  return supermemoryConfigured
    ? tools.filter((tool) => tool.name !== "remember")
    : tools.filter((tool) => !SUPERMEMORY_TOOL_NAMES.has(tool.name));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/adapters && npx vitest run src/memory-tools.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Wire it into `executor.ts`**

Add `findWorkspaceMemoryConfig` to the `@rakazo/db` imports, and `selectMemoryTools` to the `./memory-tools.js` import in `executor.ts`. Add `findWorkspaceMemoryConfig(deps.prisma, run.workspaceId)` to the existing `Promise.all([...])` that already fetches `connectedPlugins`/`findDefaultModelCredential`/`deploymentSettings` (around line 301-306), capturing it as `memoryConfig` in the destructured result.

Then, where `builtins` is assembled (around line 356-358), replace:

```typescript
        const builtins = graphical
          ? builtinAgentTools
          : builtinAgentTools.filter((tool) => !GRAPHICAL_AGENT_TOOLS.has(tool.name));
```

with:

```typescript
        const nonGraphical = graphical
          ? builtinAgentTools
          : builtinAgentTools.filter((tool) => !GRAPHICAL_AGENT_TOOLS.has(tool.name));
        const builtins = selectMemoryTools(nonGraphical, Boolean(memoryConfig));
```

- [ ] **Step 6: Resolve the config secret and scope-aware container tag at the call sites**

Decrypt once, alongside the existing `resolveModelKey` call: after `const resolved = await resolveModelKey(...)` (around line 340-347), add:

```typescript
        const supermemory = memoryConfig
          ? {
              baseUrl: memoryConfig.baseUrl,
              apiKey: deps.secretStore!.load(
                (await deps.prisma.secret.findUniqueOrThrow({ where: { id: memoryConfig.secretId } }))
                  .ciphertext,
              ),
              containerTag: supermemoryContainerTagFor(
                effectiveMemoryScope(bot.memoryScope, memoryConfig.defaultMemoryScope),
                bot.id,
                run.workspaceId,
              ),
            }
          : null;
```

Then replace the `recall_memory`/`save_memory` dispatch cases (lines 582-591):

```typescript
          if (name === "recall_memory") {
            return searchSupermemory(String(args.query ?? ""), supermemory!.containerTag, supermemory!);
          }
          if (name === "save_memory") {
            return finish(
              await saveSupermemoryMemory(String(args.content ?? ""), supermemory!.containerTag, supermemory!),
            );
          }
```

(These two branches are only reachable when `builtins` included the Supermemory tools, i.e. `memoryConfig`/`supermemory` is non-null — the `!` reflects that invariant, not an unchecked cast across unrelated code.)

Remove the now-unused `supermemoryContainerTag` import from `./supermemory-client.js`.

- [ ] **Step 7: Typecheck the adapters package**

Run: `cd packages/adapters && npx tsc --noEmit -p tsconfig.json`
Expected: exits 0 — this wiring has no dedicated automated test (see the note at the top of this task), so a clean typecheck plus the manual dev-stack verification in Task 9 is what confirms it.

- [ ] **Step 8: Run the full adapters test suite**

Run: `cd packages/adapters && npx vitest run`
Expected: PASS — confirms nothing else in the package (e.g. any fixture that imported `supermemoryContainerTag`) broke from removing it.

- [ ] **Step 9: Commit**

```bash
git add packages/adapters/src/executor.ts packages/adapters/src/memory-tools.ts packages/adapters/src/memory-tools.test.ts
git commit -m "Gate native vs Supermemory memory tools on WorkspaceMemoryConfig, resolve scope-aware container tags"
```

---

### Task 8: UI — workspace Supermemory connect settings

**Files:**
- Create: `apps/web/src/pages/SupermemorySettingsOverlay.tsx` (mirroring the structure of `apps/web/src/pages/ModelSettingsOverlay.tsx`: fetch current state on mount, a form, an error banner, a pending/connect button)
- Modify: `apps/web/src/pages/Shell.tsx` (wire in an entry point to open the new overlay, next to wherever `ModelSettingsOverlay` is opened)
- Modify: `apps/web/src/lib/rpc.ts` if it hand-lists procedures (check whether it needs new entries or picks up `memory.*` automatically from the contract)

**Interfaces:**
- Consumes: `rpc.memory.supermemoryConfig()`, `rpc.memory.connectSupermemory(input)`, `rpc.memory.disconnectSupermemory()` (Task 3/5).

- [ ] **Step 1: Check whether `rpc.ts` needs manual wiring**

Run: `grep -n "models:" apps/web/src/lib/rpc.ts`
If procedures are derived automatically from the contract (likely, given oRPC), no change is needed here — confirm by checking how `models.connect` is already called from `ModelSettingsOverlay.tsx` and whether that required any entry in `rpc.ts` beyond the contract itself.

- [ ] **Step 2: Build the overlay component**

Read `apps/web/src/pages/ModelSettingsOverlay.tsx` in full first, and copy its data-fetching/error-banner/pending-button structure. Build a form with: a Cloud/Local radio choice, an API key input, a base URL input (shown only for Local, defaulting to `http://localhost:6767`), a default-scope radio (Isolated/Shared), a Connect button calling `rpc.memory.connectSupermemory`, and — when already connected — a summary (`mode`, `baseUrl`, `defaultMemoryScope`) with a Disconnect button calling `rpc.memory.disconnectSupermemory`. Surface `probe` failures (thrown as `ORPCError("BAD_REQUEST", ...)` from Task 5) as the error banner text.

- [ ] **Step 3: Wire the entry point**

In `Shell.tsx`, add whatever button/menu item already opens `ModelSettingsOverlay` as the pattern to copy for opening `SupermemorySettingsOverlay` (same state-toggle-and-render approach).

- [ ] **Step 4: Manual verification**

Start the dev stack (`pnpm dev`), open the new settings surface, connect Local mode against the already-running `http://localhost:6767` instance using its real key, confirm the connected summary renders, then Disconnect and confirm it clears.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/SupermemorySettingsOverlay.tsx apps/web/src/pages/Shell.tsx
git commit -m "Add workspace Supermemory connect/disconnect settings UI"
```

---

### Task 9: UI — per-bot isolated/shared toggle

**Files:**
- Modify: wherever the existing per-bot settings panel lives (the component rendering `notifyOnFinish`/`pinned`/`color` editing — locate via `grep -rln "notifyOnFinish" apps/web/src --include="*.tsx"`)

**Interfaces:**
- Consumes: `bot.memoryScope`, `rpc.bots.update({ botId, memoryScope })` (Task 3/6).

- [ ] **Step 1: Add the toggle**

In the located bot settings component, add an Isolated/Shared radio (plus an "inherit workspace default" option represented as `null`) next to the existing `notifyOnFinish` toggle, calling `rpc.bots.update({ botId: bot.id, memoryScope })` on change. Only render this control when `rpc.memory.supermemoryConfig()` returns non-null for the workspace (no Supermemory connected → no scope choice to make, matches the supersession rule).

- [ ] **Step 2: Manual verification**

With a Supermemory config connected from Task 8, open a bot's settings, switch it to Shared, send it a message asking it to remember something, then switch a second bot in the same workspace to Shared and confirm it can recall what the first bot saved (same `rakazo:workspace:<id>` tag). Switch back to Isolated and confirm the second bot can no longer recall it.

- [ ] **Step 3: Commit**

```bash
git add <the modified settings component path>
git commit -m "Add per-bot isolated/shared Supermemory scope toggle"
```
