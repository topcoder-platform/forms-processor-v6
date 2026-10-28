import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ActionError,
  type Action,
  type ActionContext,
  type ActionResult,
  type ClassificationRecord,
} from "./actions.js";
import { AiError, type AiApiClient, type WorkflowRun } from "./ai.js";
import { labelSchema, UNKNOWN_LABEL, type Submission } from "./contracts.js";
import { toClassificationInput } from "./lets-talk.js";

export const classifySettingsSchema = z
  .object({
    workflowId: z.string().min(1).max(100),
    /** Runs to start before giving up on failed runs (invalid model output, provider errors). */
    maxAttempts: z.number().int().min(1).max(20),
    /** Minutes since receipt after which transport/configuration failures stop retrying. */
    maxAgeMinutes: z.number().int().min(1),
  })
  .strict();

/** The verified part of a successful lets-talk-classification result. */
const resultSchema = z.object({
  classification: labelSchema,
  confidence: z.number().min(0).max(1),
  needsReview: z.boolean(),
  detectedLanguage: z.string().max(8).optional(),
  rationale: z.string().optional(),
});

/** Stays below the processor's 45 s idle-in-transaction limit while the delivery row is locked. */
export const CLASSIFY_DEADLINE_MS = 30_000;
const IN_PROGRESS = new Set(["running", "pending", "waiting"]);
/** How a retryable code is recorded when the age limit turns it into a final failure. */
const EXPIRED_CODES: Readonly<Record<string, string>> = {
  ai_timeout: "ai_timeout_expired",
  ai_run_in_progress: "ai_run_stuck",
};

/**
 * The `ai-classify` action (ADR 0001, Decision 1): classifies a submission with a tc-ai-api
 * workflow and reports the verdict, which the store saves before routing the flows for its label.
 * Every terminal outcome — success or give-up — resolves with a classification; only retryable
 * situations throw, carrying the run id/attempt count to save with the retry.
 */
export class ClassifyAction implements Action {
  /** Accepts the AI client; undefined defers deliveries as missing_ai_configuration. Never throws. */
  constructor(
    private readonly client: AiApiClient | undefined,
    private readonly now: () => number = Date.now,
    private readonly deadlineMs = CLASSIFY_DEADLINE_MS,
  ) {}

  async execute(
    event: Submission,
    settings: unknown,
    context?: ActionContext,
  ): Promise<ActionResult> {
    const parsed = classifySettingsSchema.safeParse(settings);
    if (!parsed.success) throw new ActionError("invalid_classify_settings");
    const s = parsed.data;
    const stored = context?.classification;
    const record = (
      fields: Partial<ClassificationRecord>,
    ): ClassificationRecord => ({
      workflowId: s.workflowId,
      status: "PENDING",
      label: UNKNOWN_LABEL,
      attempts: stored?.attempts ?? 0,
      ...fields,
    });
    const expired =
      !!context &&
      this.now() - context.receivedAt.getTime() > s.maxAgeMinutes * 60_000;

    try {
      if (!this.client) throw new ActionError("missing_ai_configuration");
      const signal = AbortSignal.timeout(this.deadlineMs);

      // A previous attempt timed out: its run may have finished since, so read it instead of paying again.
      if (stored?.workflowRunId && stored.lastError === "ai_timeout") {
        const previous = await this.client.get(
          s.workflowId,
          stored.workflowRunId,
          signal,
        );
        if (previous && IN_PROGRESS.has(previous.status))
          throw new ActionError(
            "ai_run_in_progress",
            record({
              workflowRunId: stored.workflowRunId,
              lastError: "ai_timeout",
            }),
          );
        if (previous?.status === "success")
          return this.outcome(
            previous,
            stored.workflowRunId,
            stored.attempts,
            s,
            record,
          );
      }

      // A fresh id per run: Mastra overwrites the record of a reused run id.
      const runId = randomUUID();
      const attempts = (stored?.attempts ?? 0) + 1;
      let run: WorkflowRun;
      try {
        run = await this.client.start(
          s.workflowId,
          runId,
          toClassificationInput(event),
          signal,
        );
      } catch (error) {
        if (error instanceof AiError && error.timedOut)
          throw new ActionError(
            "ai_timeout",
            record({ workflowRunId: runId, attempts, lastError: "ai_timeout" }),
          );
        throw error;
      }
      return this.outcome(run, runId, attempts, s, record);
    } catch (error) {
      const code =
        error instanceof ActionError || error instanceof AiError
          ? error.message
          : "ai_classify_failed";
      const state =
        error instanceof ActionError ? error.classification : undefined;
      // Unavailable, misconfigured, or a run that never finishes (e.g. left "running" by a
      // tc-ai-api crash): past maxAgeMinutes, give up so the UNKNOWN fallback can run.
      if (expired)
        return {
          classification: record({
            ...state,
            status: "FAILED",
            label: UNKNOWN_LABEL,
            lastError: EXPIRED_CODES[code] ?? code,
          }),
        };
      throw new ActionError(code, state ?? record({ lastError: code }));
    }
  }

  /** Turn a finished run into a final classification, or a retry for a failed run below the attempt limit. */
  private outcome(
    run: WorkflowRun,
    runId: string,
    attempts: number,
    s: z.infer<typeof classifySettingsSchema>,
    record: (fields: Partial<ClassificationRecord>) => ClassificationRecord,
  ): ActionResult {
    if (run.status === "success") {
      const result = resultSchema.safeParse(run.result);
      if (result.success)
        return {
          classification: record({
            status: "CLASSIFIED",
            label: result.data.classification,
            confidence: result.data.confidence,
            needsReview: result.data.needsReview,
            detectedLanguage: result.data.detectedLanguage,
            rationale: result.data.rationale?.slice(0, 500),
            workflowRunId: runId,
            attempts,
          }),
        };
      return this.failedRun("ai_invalid_result", runId, attempts, s, record);
    }
    // The workflow rejected the input: retrying the same submission can't succeed.
    if (run.errorMessage?.startsWith("[LETS_TALK_INVALID_INPUT]"))
      return {
        classification: record({
          status: "FAILED",
          workflowRunId: runId,
          attempts,
          lastError: "ai_invalid_input",
        }),
      };
    return this.failedRun("ai_run_failed", runId, attempts, s, record);
  }

  /** Retry a failed run with a new id until maxAttempts, then give up as FAILED/UNKNOWN. */
  private failedRun(
    code: string,
    runId: string,
    attempts: number,
    s: z.infer<typeof classifySettingsSchema>,
    record: (fields: Partial<ClassificationRecord>) => ClassificationRecord,
  ): ActionResult {
    const state = record({ workflowRunId: runId, attempts, lastError: code });
    if (attempts < s.maxAttempts) throw new ActionError(code, state);
    return { classification: { ...state, status: "FAILED" } };
  }
}
