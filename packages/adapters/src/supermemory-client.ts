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

function authHeaders(config: SupermemoryConnectionConfig): Record<string, string> {
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
