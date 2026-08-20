# Supermemory memory mode: workspace config + per-bot scope

## Problem

Rakazo's cross-session memory (`recall_memory`/`save_memory`, backed by
`supermemory-client.ts`) currently reads a single deployment-wide
`SUPERMEMORY_API_KEY`/`SUPERMEMORY_API_URL` from `process.env`. There is no
per-workspace credential, no choice between a self-hosted Supermemory
instance and Supermemory Cloud, and no way to share memory across bots
in a workspace — every bot is hard-isolated to `rakazo:<botId>`.

This design makes Supermemory a first-class, workspace-configurable memory
backend: a workspace connects it once (cloud or local), it automatically
supersedes native `MEMORY.md` memory for that workspace, and each bot picks
whether its memory is isolated to itself or shared with the rest of the
workspace.

## Explicitly out of scope

- **The existing "Supermemory" entry in the Plugins catalog.** That's a
  Composio-toolkit-backed connection, unrelated to this feature, left
  exactly as-is. It executes tool calls from a hosted service (not
  Rakazo's own server), exposes 11 raw tools with an agent-settable
  `container_tag`, and only reaches Supermemory Cloud. None of that changes
  here, and this feature does not read from or write to that catalog entry.
- **One-click auto-provisioning of a fresh local Supermemory instance.**
  Supermemory's self-hosted install is a single official command
  (`npx supermemory local` / `curl -fsSL https://supermemory.ai/install | bash`),
  but first boot is interactive (prompts for an LLM key) and there's no
  official service/daemon story — Rakazo would own keeping it alive. That's
  real infrastructure work on the order of the existing
  `infra/sandboxes/supervisor`, and is a separate follow-on effort. This
  design only detects and connects to an **already-running** local
  instance.
- **Supermemory history compaction** (`feat/supermemory-history-compaction`,
  already speced and planned separately). Untouched by this work.

## Data model

New table, following the existing convention of workspace-scoped concerns
living in their own table referencing `workspaceId` (as `MemoryDocument`
and `NotificationPreference` already do), rather than columns on
`Organization` (a better-auth-managed table) or the deployment-wide
`DeploymentSettings` singleton:

```prisma
model WorkspaceMemoryConfig {
  id                 String   @id @default(cuid())
  workspaceId        String   @unique
  workspace          Organization @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  userId             String
  mode               String   // "cloud" | "local"
  baseUrl            String
  secretId           String
  defaultMemoryScope String   @default("isolated") // "isolated" | "shared"
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt

  @@map("workspace_memory_configs")
}
```

`secretId` points at the existing generic `Secret` table
(`kind: "supermemory"`), written/read through the existing
`EncryptedSecretStore`, mirroring `UserModelCredential` exactly (see
`persistModelCredential` in `apps/api/src/router.ts` and `resolveModelKey`
in `packages/adapters/src/executor.ts`). No new encryption code.

`Bot` gets one new nullable column:

```prisma
memoryScope String? // "isolated" | "shared" | null = inherit workspace default
```

`Organization` gets a new back-relation field
(`workspaceMemoryConfig WorkspaceMemoryConfig?`), matching its existing
`memoryDocuments MemoryDocument[]`-style relations.

## Behavior

**Supersession.** A workspace either has a `WorkspaceMemoryConfig` row or
it doesn't — there is no separate on/off toggle. If it exists, that
workspace's bots get `recall_memory`/`save_memory` backed by Supermemory;
if it doesn't, they get the existing native `MEMORY.md` tools. This mirrors
how `findDefaultModelCredential` already gates model auth: presence of a
row is the switch, not a flag next to it.

**Scope resolution.** `effectiveScope(bot) = bot.memoryScope ?? workspaceMemoryConfig.defaultMemoryScope`.
The resulting container tag:
- `isolated` → `rakazo:<botId>` (today's behavior, unchanged)
- `shared` → `rakazo:workspace:<workspaceId>` (new — bots opting into
  "shared" in the same workspace pool into one container tag)

The tag is computed server-side in `executor.ts`, exactly as today —
never exposed to or settable by the agent. This is the one property that
must survive from the native implementation: Composio's raw Supermemory
toolkit lets the agent set `container_tag` freely, which is precisely the
isolation gap this design avoids by keeping our own two curated tools
instead of exposing that toolkit directly.

**Connecting.** A settings surface (workspace-level, e.g. alongside
existing bot/workspace settings — not the Plugins overlay) lets a user
pick Cloud or Local:
- **Cloud**: enter their Supermemory *organization* API key
  (`sm_...`, from console.supermemory.ai). `baseUrl` is fixed to
  `https://api.supermemory.ai`.
- **Local**: enter a base URL (defaulting to `http://localhost:6767`) and
  that instance's own API key. Rakazo's backend calls it directly — no
  tunnel needed, since (unlike the Plugins catalog entry) execution happens
  from Rakazo's own server. Connecting probes the given `baseUrl`+key with
  a real authenticated call (`POST /v3/container-tags/list`, the same
  lightweight endpoint the OpenWork integration used to verify a running
  instance) before saving — a bare root fetch only proves *something* is
  listening, not that it's a working, correctly-keyed Supermemory instance.
  Surfaces a clear error if the probe fails — no auto-provisioning attempt.

Saving either path writes one `WorkspaceMemoryConfig` row (upsert on
`workspaceId`), following `persistModelCredential`'s transaction shape:
`secrets.put()` → `prisma.secret.create()` → upsert the config row with
the resulting `secretId`.

**Runtime resolution.** `supermemory-client.ts`'s `supermemoryConfig()`
becomes a `findSupermemoryConfig(prisma, workspaceId)` helper mirroring
`findDefaultModelCredential`, called in `executor.ts` at the same point
`run.workspaceId`/`bot.workspaceId` is already loaded (right where
`connectedPlugins`/`findDefaultModelCredential` are already fetched
alongside the run). The secret is decrypted via the existing
`deps.secretStore.load(row.ciphertext)`, exactly like `resolveModelKey`
does for model credentials — no new crypto path.

## Error handling

- No `WorkspaceMemoryConfig` row → native `MEMORY.md` tools, unchanged
  behavior, no error.
- Row exists but the Supermemory instance is unreachable at call time
  (local instance stopped, cloud outage) → `recall_memory`/`save_memory`
  return the existing `SupermemorySearchResponse`/`SupermemorySaveResponse`
  `{ ok: false, error }` shape already defined in `supermemory-client.ts`;
  the agent sees the error and can decide how to proceed. No fallback to
  native `MEMORY.md` mid-run — supersession is a workspace property, not a
  per-call fallback.

## Testing

- `findSupermemoryConfig`: returns `null` when no row exists; returns the
  row when one does.
- `effectiveScope`: `bot.memoryScope` set → used as-is; unset → falls back
  to `workspaceMemoryConfig.defaultMemoryScope`.
- Container tag derivation: `isolated` → `rakazo:<botId>`; `shared` →
  `rakazo:workspace:<workspaceId>`.
- Tool selection in `executor.ts`: config present → Supermemory tools
  offered, native memory tools absent; config absent → native tools
  offered, Supermemory tools absent.
- Settings persistence: saving Cloud vs Local writes the expected `mode`/
  `baseUrl`, reuses an existing `secretId` row when only the key changes
  (mirroring `persistModelCredential`'s update-vs-create branch), and the
  local-connect probe rejects an unreachable `baseUrl` before saving.
- Existing `supermemory-client.test.ts` cases continue to pass unchanged
  (the HTTP call shape doesn't change, only where `baseUrl`/`apiKey` come
  from).
