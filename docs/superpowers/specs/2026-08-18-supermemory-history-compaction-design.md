# Supermemory-backed history compaction

Status: approved design, not yet implemented
Date: 2026-08-18

## Problem

Every agent run builds its model context from `deps.prisma.message.findMany({ orderBy: { seq: "desc" }, take: MAX_AGENT_HISTORY_MESSAGES })` in `packages/adapters/src/executor.ts` (`MAX_AGENT_HISTORY_MESSAGES = 200`). This is a hard cliff, not a budget: the most recent 200 messages are sent in full on every single run, and anything older simply vanishes from context with no summarization or compression. For a long-lived, actively used bot this means:

- Growing token cost per run as a bot's history accumulates, right up until the 200-message ceiling.
- A hard discontinuity at the ceiling — context that mattered 201 messages ago is gone, with nothing standing in for it.

This was previously filed upstream as elie222/rakazo#61 with no fix designed. Separately, this session built a working Supermemory integration (`recall_memory`/`save_memory` tools, verified end-to-end against a live Supermemory server) as an *additional* memory store alongside the existing `remember`/`MEMORY.md` system. Bolting automatic Supermemory recall onto every run without addressing the underlying cliff would mostly duplicate what's already in the 200-message window — the real opportunity is to make Supermemory the layer that absorbs what the verbatim window can no longer hold, rather than a parallel system.

## Goals

- Replace the hard cliff with: a smaller verbatim window of recent messages, plus older messages compacted into durable, searchable summaries in Supermemory instead of being silently dropped.
- Make retrieval of compacted context reliable without paying its cost on every single run.
- Zero behavior change for any deployment that hasn't configured Supermemory — this is being built as a contribution to the upstream open-source project (elie222/rakazo), and must be safe for the default setup nobody has opted into Supermemory for.

## Non-goals

- Removing or reworking the `remember`/`MEMORY.md` tool. That was discussed in the same session as a related, follow-on piece (a `remember` vs. `save_memory` tool-choice ambiguity, and `remember`'s destructive overwrite-not-append semantics), but is out of scope here and will get its own short design.
- Managing Supermemory's own retention/expiry of stored memories — that's Supermemory's concern, not Rakazo's.
- Cross-bot or cross-workspace memory sharing. Compaction is scoped per-bot, matching the existing `save_memory`/`recall_memory` container-tag scheme (`rakazo:<botId>`).

## Design

### Feature gate

Everything below is active only when Supermemory is configured (`SUPERMEMORY_API_KEY` present — the same convention `supermemory-client.ts` already uses). When it isn't configured, `MAX_AGENT_HISTORY_MESSAGES` stays at 200 exactly as today.

### Components

- **Smaller verbatim window.** `HISTORY_WINDOW_SIZE = 50` messages sent as-is per run when Supermemory is configured — down from 200, but otherwise unchanged in spirit: still "most recent N messages, in full."
- **A per-thread compaction cursor.** A new `historyCompactedUpToSeq` field (nullable) tracks how far compaction has progressed. `null` means nothing has ever been compacted for this thread.
- **A background compaction job** (`history.compact`, via the existing graphile-worker queue already used for routines/wakeups). Triggered after a run completes, if enough messages have accumulated beyond the verbatim window to make a full batch available: `COMPACTION_BATCH_SIZE = 50`. The job:
  1. Reads the next un-compacted batch — messages with `seq > historyCompactedUpToSeq` (or from the start, if `null`), up to `COMPACTION_BATCH_SIZE`.
  2. Summarizes that batch with an LLM call: a concise, factual summary capturing key facts, decisions, and context (exact prompt wording is an implementation detail).
  3. Saves the summary to Supermemory via the existing `saveSupermemoryMemory()`.
  4. Advances `historyCompactedUpToSeq` to the last message's `seq` in that batch — only after the save succeeds.
- **Conditional auto-recall at run start.** If `historyCompactedUpToSeq` is set (non-null) for the thread, search Supermemory with the incoming prompt (`searchSupermemory(prompt, containerTag)`) and inject up to the top 5 results into context, in the same spot `loadAgentMemoryContext()`'s `<durable_memory>` block is injected today. If it's `null`, skip entirely — there's nothing compacted yet to recall, so no wasted search.

### Summarizer model selection

Compaction uses Rakazo's platform default model (`PI_DEFAULT_MODEL`/OpenRouter) when a usable cloud credential is configured. If not — e.g. a deployment running purely on local-mlx/Ollama with no cloud credential at all — it falls back to the bot's own configured model instead of skipping compaction. This accepts that a shared local-mlx server may see background compaction jobs contend with live chat traffic; that's a worse-case tradeoff, not a failure mode, and better than compaction silently never running.

### Data flow

**Live run (Supermemory configured):**
1. Run starts. If `historyCompactedUpToSeq` is set, auto-recall runs (search + inject). If not, skip.
2. Verbatim history: most recent `HISTORY_WINDOW_SIZE` messages, regardless of compaction state.
3. Run proceeds and completes normally.
4. After completion, check whether `(messages with seq > historyCompactedUpToSeq)` has reached `HISTORY_WINDOW_SIZE + COMPACTION_BATCH_SIZE`. If so, enqueue `history.compact` for this thread. This check is pure arithmetic on message counts — cheap enough to run after every completion without meaningfully affecting latency.

**Background compaction job:** as described under Components above.

### Error handling

- **Summarization LLM call fails**, or **Supermemory save fails**: the job fails and graphile-worker retries it, matching how routines/wakeups already behave. The cursor never advances until a summary is successfully saved — no stretch of conversation is silently skipped or lost.
- **Auto-recall search fails at run start**: degrades exactly like `recall_memory` already does today (`{ ok: false }`, logged, run proceeds without the injected context). Never blocks or breaks the live conversation.
- **No usable cloud credential and bot's own model is local-mlx**: compaction still runs, accepting resource contention (see above) — an accepted tradeoff, not an error case.

### Testing

- Pure logic (batch-boundary arithmetic — "has a full batch aged out," "what's the next batch's seq range") as TDD unit tests, matching this session's established pattern for pure functions.
- The compaction job's summarize-then-save flow tested with mocked model and Supermemory calls, following whichever convention this repo's existing graphile-worker job tests already use (`wakeup.test.ts` / `job-reconciler.test.ts`) rather than inventing a new pattern.
- Auto-recall injection tested the same way `loadAgentMemoryContext` injection is tested today.

## Open questions for implementation planning

- Exact schema mechanics for `historyCompactedUpToSeq` (new column on `Thread`, migration details).
- Exact summarization prompt wording.
- Whether the post-run compaction-trigger check belongs inline in `executor.ts` or as a separate step — functionally equivalent, this is purely a code-organization call for the implementation plan.
