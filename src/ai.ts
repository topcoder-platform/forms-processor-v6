import { AuthError, M2MTokenProvider, type M2MConfig } from "./auth.js";

/** Settings for calling tc-ai-api workflows with an M2M token. */
export interface AiConfig extends M2MConfig {
  /** tc-ai-api base ending in /v6/ai, e.g. https://api.topcoder.com/v6/ai. */
  AI_API_URL: string;
}

/** A workflow run as returned by start-async and GET …/runs/:runId (Mastra 1.74). */
export interface WorkflowRun {
  /** running | success | failed | suspended | pending | canceled | … */
  status: string;
  result?: unknown;
  /** The run error's message, e.g. "[LETS_TALK_INVALID_INPUT] …". */
  errorMessage?: string;
}

/** A failed AI API call with a fixed code safe to persist and log; never a response body. */
export class AiError extends Error {
  /** True when the request timed out or was aborted, so the run may still be executing. */
  constructor(
    code: string,
    readonly timedOut = false,
  ) {
    super(code);
  }
}

/** Starts and reads tc-ai-api workflow runs with abortable requests and cached M2M tokens. */
export class AiApiClient {
  private readonly tokens: M2MTokenProvider;
  /** Accepts validated settings and optional HTTP/clock dependencies; performs no network requests. */
  constructor(
    private readonly config: AiConfig,
    private readonly request: typeof fetch = fetch,
    now: () => number = Date.now,
  ) {
    this.tokens = new M2MTokenProvider(config, request, now);
  }

  /** Start a run under a caller-chosen id and wait for it. Resolves with the run's final
   * state (success or failed alike); throws AiError for HTTP, auth, network and timeout failures.
   */
  start(
    workflowId: string,
    runId: string,
    inputData: unknown,
    signal: AbortSignal,
  ): Promise<WorkflowRun> {
    return this.call(
      `/workflows/${encodeURIComponent(workflowId)}/start-async?runId=${encodeURIComponent(runId)}`,
      { method: "POST", body: JSON.stringify({ inputData }) },
      signal,
    ) as Promise<WorkflowRun>;
  }

  /** Read a run's state; resolves null when the run doesn't exist (404). Throws AiError otherwise. */
  get(
    workflowId: string,
    runId: string,
    signal: AbortSignal,
  ): Promise<WorkflowRun | null> {
    return this.call(
      `/workflows/${encodeURIComponent(workflowId)}/runs/${encodeURIComponent(runId)}?fields=result,error`,
      { method: "GET" },
      signal,
      true,
    );
  }

  /** Perform one authenticated JSON request and normalize the run payload. */
  private async call(
    path: string,
    init: { method: string; body?: string },
    signal: AbortSignal,
    notFoundIsNull = false,
  ): Promise<WorkflowRun | null> {
    try {
      const token = await this.tokens.get(signal);
      const response = await this.request(`${this.config.AI_API_URL}${path}`, {
        ...init,
        redirect: "error",
        signal,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });
      if (response.status === 401) this.tokens.invalidate();
      if (notFoundIsNull && response.status === 404) {
        await response.body?.cancel().catch(() => {});
        return null;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new AiError(`ai_http_${response.status}`);
      }
      return toRun(await response.json());
    } catch (error) {
      if (error instanceof AiError) throw error;
      if (error instanceof AuthError) throw new AiError(`ai_${error.message}`);
      if (signal.aborted) throw new AiError("ai_timeout", true);
      throw new AiError("ai_network_error");
    }
  }
}

/** Extract status/result/error message from an untrusted run payload; throws AiError when malformed. */
function toRun(body: unknown): WorkflowRun {
  if (!body || typeof body !== "object" || !("status" in body))
    throw new AiError("ai_invalid_response");
  const { status, result, error } = body as Record<string, unknown>;
  if (typeof status !== "string") throw new AiError("ai_invalid_response");
  const message =
    typeof error === "string"
      ? error
      : error && typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message)
        : undefined;
  return {
    status,
    ...(result !== undefined ? { result } : {}),
    ...(message !== undefined ? { errorMessage: message } : {}),
  };
}
