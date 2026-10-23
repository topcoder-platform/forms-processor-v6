import { test } from "node:test";
import assert from "node:assert/strict";
import { AiApiClient, AiError, type AiConfig } from "../src/ai.js";
import { config } from "../src/config.js";

const options: AiConfig = {
  AI_API_URL: "https://api.example.com/v6/ai",
  AUTH0_URL: "https://auth.example.com/oauth/token",
  AUTH0_AUDIENCE: "https://m2m.example.com/",
  AUTH0_CLIENT_ID: "client",
  AUTH0_CLIENT_SECRET: "secret",
};
const runId = "6f1c2a9e-6b7d-4e8f-9a01-2b3c4d5e6f70";
const signal = () => AbortSignal.timeout(5000);

/** A fake fetch: tokens from AUTH0_URL, everything else from `respond`. */
function fake(
  respond: (url: string, init: RequestInit) => Response | Promise<Response>,
) {
  const calls: { url: string; init: RequestInit }[] = [];
  let tokens = 0;
  const request: typeof fetch = async (url, init) => {
    if (url === options.AUTH0_URL) {
      tokens++;
      assert.equal(
        JSON.parse(String(init?.body)).audience,
        options.AUTH0_AUDIENCE,
      );
      return Response.json({ access_token: "token", expires_in: 3600 });
    }
    calls.push({ url: String(url), init: init! });
    return respond(String(url), init!);
  };
  return { request, calls, tokens: () => tokens };
}

test("starts a run under the given id and returns its final state", async () => {
  const http = fake(() =>
    Response.json({
      status: "success",
      result: { classification: "SALES_LEAD" },
      steps: {},
    }),
  );
  const run = await new AiApiClient(options, http.request).start(
    "lets-talk-classification",
    runId,
    { firstName: "Ana" },
    signal(),
  );
  assert.deepEqual(run, {
    status: "success",
    result: { classification: "SALES_LEAD" },
  });
  const [call] = http.calls;
  assert.equal(
    call.url,
    `${options.AI_API_URL}/workflows/lets-talk-classification/start-async?runId=${runId}`,
  );
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.redirect, "error");
  assert.equal(
    (call.init.headers as Record<string, string>).Authorization,
    "Bearer token",
  );
  assert.deepEqual(JSON.parse(String(call.init.body)), {
    inputData: { firstName: "Ana" },
  });
});

test("extracts the error message of a failed run", async () => {
  const http = fake(() =>
    Response.json({
      status: "failed",
      error: {
        message: "[LETS_TALK_INVALID_INPUT] Invalid submission",
        status: 400,
      },
    }),
  );
  assert.deepEqual(
    await new AiApiClient(options, http.request).start(
      "w",
      runId,
      {},
      signal(),
    ),
    {
      status: "failed",
      errorMessage: "[LETS_TALK_INVALID_INPUT] Invalid submission",
    },
  );
});

test("reads a run with a reduced field set, and returns null for an unknown run", async () => {
  let status = 200;
  const http = fake(() =>
    status === 404
      ? new Response("nope", { status: 404 })
      : Response.json({ status: "running" }),
  );
  const client = new AiApiClient(options, http.request);
  assert.deepEqual(await client.get("w", runId, signal()), {
    status: "running",
  });
  assert.equal(
    http.calls[0].url,
    `${options.AI_API_URL}/workflows/w/runs/${runId}?fields=result,error`,
  );
  assert.equal(http.calls[0].init.method, "GET");
  status = 404;
  assert.equal(await client.get("w", runId, signal()), null);
});

test("HTTP, auth and malformed responses become sanitized codes; 401 drops the cached token", async () => {
  const http = fake(() => new Response("secret body", { status: 401 }));
  const client = new AiApiClient(options, http.request);
  await assert.rejects(
    client.start("w", runId, {}, signal()),
    /^Error: ai_http_401$/,
  );
  await assert.rejects(
    client.start("w", runId, {}, signal()),
    /^Error: ai_http_401$/,
  );
  assert.equal(http.tokens(), 2);

  await assert.rejects(
    new AiApiClient(
      options,
      async () => new Response("x", { status: 403 }),
    ).start("w", runId, {}, signal()),
    /^Error: ai_auth_http_403$/,
  );
  await assert.rejects(
    new AiApiClient(
      options,
      fake(() => Response.json({ nope: true })).request,
    ).start("w", runId, {}, signal()),
    /ai_invalid_response/,
  );
  // start-async 404 (unknown workflow) is an error, not "no run".
  await assert.rejects(
    new AiApiClient(
      options,
      fake(() => new Response("", { status: 404 })).request,
    ).start("w", runId, {}, signal()),
    /ai_http_404/,
  );
});

test("a timeout is reported as timedOut; other transport errors are not", async () => {
  const hang = fake(
    (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal!.addEventListener("abort", () =>
          reject(new Error("aborted")),
        ),
      ),
  );
  const timedOut = await new AiApiClient(options, hang.request)
    .start("w", runId, {}, AbortSignal.timeout(20))
    .catch((error: unknown) => error);
  assert.ok(timedOut instanceof AiError);
  assert.equal(timedOut.message, "ai_timeout");
  assert.equal(timedOut.timedOut, true);

  const broken = await new AiApiClient(
    options,
    fake(() => {
      throw new Error("secret");
    }).request,
  )
    .start("w", runId, {}, signal())
    .catch((error: unknown) => error);
  assert.ok(broken instanceof AiError);
  assert.equal(broken.message, "ai_network_error");
  assert.equal(broken.timedOut, false);
});

test("AI config reuses the Bus M2M identity, with an optional audience, and validates its base URL", () => {
  const base = {
    DATABASE_URL: "postgresql://localhost/test",
    KAFKA_URL: "localhost:9092",
  };
  const m2m = {
    BUSAPI_URL: "https://api.example.com/v6",
    AUTH0_URL: options.AUTH0_URL,
    AUTH0_AUDIENCE: "https://bus.example.com/",
    AUTH0_CLIENT_ID: "client",
    AUTH0_CLIENT_SECRET: "secret",
  };
  assert.equal(config({ ...base, ...m2m }).aiApi, undefined);
  assert.deepEqual(
    config({ ...base, ...m2m, AI_API_URL: "https://api.example.com/v6/ai/" })
      .aiApi,
    {
      AUTH0_URL: m2m.AUTH0_URL,
      AUTH0_AUDIENCE: m2m.AUTH0_AUDIENCE,
      AUTH0_CLIENT_ID: "client",
      AUTH0_CLIENT_SECRET: "secret",
      AI_API_URL: "https://api.example.com/v6/ai",
    },
  );
  assert.equal(
    config({
      ...base,
      ...m2m,
      AI_API_URL: options.AI_API_URL,
      AI_AUTH0_AUDIENCE: "https://ai/",
    }).aiApi?.AUTH0_AUDIENCE,
    "https://ai/",
  );
  assert.throws(
    () => config({ ...base, AI_API_URL: options.AI_API_URL }),
    /AUTH0_CLIENT_SECRET/,
  );
  for (const url of [
    "https://api.example.com/v6",
    "https://u:p@api.example.com/v6/ai",
    "https://api.example.com/v6/ai?x=1",
  ])
    assert.throws(
      () => config({ ...base, ...m2m, AI_API_URL: url }),
      /^Error: Invalid configuration: AI_API_URL$/,
    );
});

test("label-action settings: defaults, list normalization and safe failures", () => {
  const base = {
    DATABASE_URL: "postgresql://localhost/test",
    KAFKA_URL: "localhost:9092",
  };
  const defaults = config(base);
  assert.deepEqual(defaults.LETS_TALK_SUPPORT_RECIPIENTS, [
    "support@topcoder.com",
  ]);
  assert.deepEqual(defaults.LETS_TALK_SALES_REPLY_TO, [
    "support@topcoder.com",
    "test1@topcoder.com",
  ]);
  assert.equal(defaults.LETS_TALK_REPLY_CAP_PER_DAY, 1);
  assert.equal(defaults.LETS_TALK_CLASSIFY_MAX_ATTEMPTS, 5);
  assert.equal(defaults.LETS_TALK_CLASSIFY_MAX_AGE_MINUTES, 30);
  for (const [key, value] of [
    ["LETS_TALK_SALES_REPLY_TO", "support@topcoder.com,"],
    ["LETS_TALK_SUPPORT_RECIPIENTS", "not-an-email"],
    ["LETS_TALK_WIPRO_TEMPLATE_ID", "d-123"],
    ["LETS_TALK_REPLY_CAP_PER_DAY", "-1"],
    ["LETS_TALK_CLASSIFY_MAX_ATTEMPTS", "0"],
  ])
    assert.throws(
      () => config({ ...base, [key!]: value }),
      new RegExp(`^Error: Invalid configuration: ${key}(?:\\.\\d+)?$`),
    );
});
