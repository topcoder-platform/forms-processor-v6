import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ActionError,
  type ActionContext,
  type StoredClassification,
} from "../src/actions.js";
import { AiError, type AiApiClient, type WorkflowRun } from "../src/ai.js";
import { ClassifyAction } from "../src/classify.js";
import { event } from "./fixtures.js";

const settings = {
  workflowId: "lets-talk-classification",
  maxAttempts: 3,
  maxAgeMinutes: 30,
};
const RECEIVED = Date.parse("2026-10-22T10:00:00Z");
const SUCCESS: WorkflowRun = {
  status: "success",
  result: {
    submissionId: event.submissionId,
    classification: "SALES_LEAD",
    confidence: 0.91,
    confidences: { SALES_LEAD: 0.91, JUNK: 0.09 },
    needsReview: false,
    detectedLanguage: "en",
    rationale: "A company asks for a development team.",
  },
};

/** A scripted AI client recording its calls. */
function client(script: {
  start?: (runId: string) => WorkflowRun | Promise<WorkflowRun>;
  get?: (runId: string) => WorkflowRun | null;
}) {
  const calls: string[] = [];
  const fakeClient = {
    start: async (workflowId: string, runId: string, input: unknown) => {
      calls.push(`start ${workflowId} ${runId}`);
      assert.equal(
        (input as { submissionId: string }).submissionId,
        event.submissionId,
      );
      if (!script.start) throw new Error("unexpected start");
      return script.start(runId);
    },
    get: async (_workflowId: string, runId: string) => {
      calls.push(`get ${runId}`);
      if (!script.get) throw new Error("unexpected get");
      return script.get(runId);
    },
  } as unknown as AiApiClient;
  return { fakeClient, calls };
}

function context(
  stored: Partial<StoredClassification> | null = null,
  minutesSinceReceipt = 1,
): { context: ActionContext; now: () => number } {
  return {
    context: {
      receivedAt: new Date(RECEIVED),
      classification: stored
        ? ({
            label: "UNKNOWN",
            status: "PENDING",
            attempts: 0,
            lastError: null,
            workflowRunId: null,
            ...stored,
          } as StoredClassification)
        : null,
      recentSubmitterSends: async () => 0,
    },
    now: () => RECEIVED + minutesSinceReceipt * 60_000,
  };
}

async function failure(promise: Promise<unknown>): Promise<ActionError> {
  const error = await promise.then(
    () => assert.fail("expected a retry"),
    (e: unknown) => e,
  );
  assert.ok(error instanceof ActionError);
  return error;
}

test("a successful run is a final CLASSIFIED verdict with the run id", async () => {
  const { fakeClient, calls } = client({ start: () => SUCCESS });
  const { context: ctx, now } = context();
  const result = await new ClassifyAction(fakeClient, now).execute(
    event,
    settings,
    ctx,
  );
  assert.equal(calls.length, 1);
  const runId = calls[0].split(" ")[2];
  assert.match(runId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(result.classification, {
    workflowId: "lets-talk-classification",
    status: "CLASSIFIED",
    label: "SALES_LEAD",
    confidence: 0.91,
    needsReview: false,
    detectedLanguage: "en",
    rationale: "A company asks for a development team.",
    workflowRunId: runId,
    attempts: 1,
  });
});

test("invalid input fails at once with UNKNOWN, without retrying", async () => {
  const { fakeClient, calls } = client({
    start: () => ({
      status: "failed",
      errorMessage: "[LETS_TALK_INVALID_INPUT] Invalid submission: workEmail",
    }),
  });
  const { context: ctx, now } = context();
  const { classification } = await new ClassifyAction(fakeClient, now).execute(
    event,
    settings,
    ctx,
  );
  assert.equal(calls.length, 1);
  assert.equal(classification?.status, "FAILED");
  assert.equal(classification?.label, "UNKNOWN");
  assert.equal(classification?.lastError, "ai_invalid_input");
});

test("a failed run retries with a new run id until maxAttempts, then fails with UNKNOWN", async () => {
  const failed: WorkflowRun = {
    status: "failed",
    errorMessage: "[LETS_TALK_INVALID_MODEL_OUTPUT] no usable classification",
  };
  const { fakeClient } = client({ start: () => failed });
  const { context: ctx, now } = context({
    attempts: 1,
    lastError: "ai_run_failed",
  });
  const retry = await failure(
    new ClassifyAction(fakeClient, now).execute(event, settings, ctx),
  );
  assert.equal(retry.message, "ai_run_failed");
  assert.equal(retry.classification?.attempts, 2);
  assert.equal(retry.classification?.status, "PENDING");

  const last = context({ attempts: 2, lastError: "ai_run_failed" });
  const { classification } = await new ClassifyAction(
    fakeClient,
    last.now,
  ).execute(event, settings, last.context);
  assert.equal(classification?.status, "FAILED");
  assert.equal(classification?.attempts, 3);
  assert.equal(classification?.lastError, "ai_run_failed");
});

test("a success with an unusable result counts as a failed run", async () => {
  const { fakeClient } = client({
    start: () => ({
      status: "success",
      result: { classification: "sales lead", confidence: 2 },
    }),
  });
  const { context: ctx, now } = context();
  const retry = await failure(
    new ClassifyAction(fakeClient, now).execute(event, settings, ctx),
  );
  assert.equal(retry.message, "ai_invalid_result");
});

test("a timeout keeps the run id; the next attempt reads that run instead of starting another", async () => {
  let timedOutRun = "";
  const first = client({
    start: (runId) => {
      timedOutRun = runId;
      throw new AiError("ai_timeout", true);
    },
  });
  const one = context();
  const retry = await failure(
    new ClassifyAction(first.fakeClient, one.now).execute(
      event,
      settings,
      one.context,
    ),
  );
  assert.equal(retry.message, "ai_timeout");
  assert.deepEqual(
    {
      runId: retry.classification?.workflowRunId,
      attempts: retry.classification?.attempts,
      lastError: retry.classification?.lastError,
    },
    { runId: timedOutRun, attempts: 1, lastError: "ai_timeout" },
  );

  // Still running: wait, keeping the same run.
  const running = client({ get: () => ({ status: "running" }) });
  const two = context({
    workflowRunId: timedOutRun,
    attempts: 1,
    lastError: "ai_timeout",
  });
  const waiting = await failure(
    new ClassifyAction(running.fakeClient, two.now).execute(
      event,
      settings,
      two.context,
    ),
  );
  assert.equal(waiting.message, "ai_run_in_progress");
  assert.equal(waiting.classification?.workflowRunId, timedOutRun);
  assert.deepEqual(running.calls, [`get ${timedOutRun}`]);

  // Finished meanwhile: use its result, no new run.
  const finished = client({ get: () => SUCCESS });
  const { classification } = await new ClassifyAction(
    finished.fakeClient,
    two.now,
  ).execute(event, settings, two.context);
  assert.equal(classification?.status, "CLASSIFIED");
  assert.equal(classification?.workflowRunId, timedOutRun);
  assert.equal(classification?.attempts, 1);
  assert.deepEqual(finished.calls, [`get ${timedOutRun}`]);

  // Gone or failed: start a fresh run.
  const gone = client({ get: () => null, start: () => SUCCESS });
  const fresh = await new ClassifyAction(gone.fakeClient, two.now).execute(
    event,
    settings,
    two.context,
  );
  assert.equal(gone.calls.length, 2);
  assert.notEqual(fresh.classification?.workflowRunId, timedOutRun);
  assert.equal(fresh.classification?.attempts, 2);
});

test("transport and configuration failures retry until maxAgeMinutes, then fail with UNKNOWN", async () => {
  const down = client({
    start: () => {
      throw new AiError("ai_http_503");
    },
  });
  const young = context(null, 10);
  const retry = await failure(
    new ClassifyAction(down.fakeClient, young.now).execute(
      event,
      settings,
      young.context,
    ),
  );
  assert.equal(retry.message, "ai_http_503");

  const old = context(null, 31);
  const { classification } = await new ClassifyAction(
    down.fakeClient,
    old.now,
  ).execute(event, settings, old.context);
  assert.equal(classification?.status, "FAILED");
  assert.equal(classification?.label, "UNKNOWN");
  assert.equal(classification?.lastError, "ai_http_503");

  // No AI client configured at all behaves the same.
  const missing = await failure(
    new ClassifyAction(undefined, young.now).execute(
      event,
      settings,
      young.context,
    ),
  );
  assert.equal(missing.message, "missing_ai_configuration");
  assert.equal(
    (
      await new ClassifyAction(undefined, old.now).execute(
        event,
        settings,
        old.context,
      )
    ).classification?.lastError,
    "missing_ai_configuration",
  );
});

test("a run still in progress past maxAgeMinutes is given up as stuck, and invalid settings never classify", async () => {
  const running = client({ get: () => ({ status: "running" }) });
  const stuckRun = "6f1c2a9e-6b7d-4e8f-9a01-2b3c4d5e6f70";
  const old = context(
    { workflowRunId: stuckRun, attempts: 1, lastError: "ai_timeout" },
    90,
  );
  const { classification } = await new ClassifyAction(
    running.fakeClient,
    old.now,
  ).execute(event, settings, old.context);
  assert.equal(classification?.status, "FAILED");
  assert.equal(classification?.label, "UNKNOWN");
  assert.equal(classification?.lastError, "ai_run_stuck");
  assert.equal(classification?.workflowRunId, stuckRun);
  await assert.rejects(
    new ClassifyAction(running.fakeClient).execute(event, { workflowId: "" }),
    /invalid_classify_settings/,
  );
});
