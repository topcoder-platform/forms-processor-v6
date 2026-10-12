import { test } from "node:test";
import assert from "node:assert/strict";
import { BusApiClient, type BusConfig, type BusEvent } from "../src/bus.js";
import { config } from "../src/config.js";
const options: BusConfig = {
  BUSAPI_URL: "https://api.example.com/v6",
  AUTH0_URL: "https://auth.example.com/oauth/token",
  AUTH0_AUDIENCE: "https://example.com",
  AUTH0_CLIENT_ID: "client",
  AUTH0_CLIENT_SECRET: "secret",
};
const event: BusEvent = {
  topic: "external.action.email",
  originator: "forms-processor-v6",
  timestamp: new Date().toISOString(),
  "mime-type": "application/json",
  key: "id",
  payload: { version: "v3" },
};

test("requests/caches M2M tokens and posts the envelope to the v6 Bus endpoint", async () => {
  let tokenRequests = 0;
  let posts = 0;
  let now = 100000;
  const request: typeof fetch = async (url, init) => {
    assert.ok(init?.signal);
    assert.equal(init.redirect, "error");
    if (url === options.AUTH0_URL) {
      tokenRequests++;
      assert.deepEqual(JSON.parse(String(init.body)), {
        grant_type: "client_credentials",
        client_id: "client",
        client_secret: "secret",
        audience: options.AUTH0_AUDIENCE,
        auth0_url: options.AUTH0_URL,
      });
      return Response.json({ access_token: "token", expires_in: 120 });
    }
    posts++;
    assert.equal(url, options.BUSAPI_URL + "/bus/events");
    assert.equal(
      (init.headers as Record<string, string>).Authorization,
      "Bearer token",
    );
    assert.deepEqual(JSON.parse(String(init.body)), event);
    return new Response(null, { status: 202 });
  };
  const client = new BusApiClient(options, request, () => now);
  await client.postEvent(event);
  await client.postEvent(event);
  assert.equal(tokenRequests, 1);
  assert.equal(posts, 2);
  now += 61000;
  await client.postEvent(event);
  assert.equal(tokenRequests, 2);
});
test("supports the standard Auth0 proxy endpoint and auth0_url field", async () => {
  const proxy = "https://proxy.example.com/token";
  const request: typeof fetch = async (url, init) => {
    if (url === proxy) {
      assert.equal(JSON.parse(String(init?.body)).auth0_url, options.AUTH0_URL);
      return Response.json({ access_token: "token" });
    }
    assert.equal(url, options.BUSAPI_URL + "/bus/events");
    return new Response(null, { status: 204 });
  };
  await new BusApiClient(
    { ...options, AUTH0_PROXY_SERVER_URL: proxy },
    request,
  ).postEvent(event);
});
test("authentication failure prevents Bus publication and never exposes response text", async () => {
  let calls = 0;
  await assert.rejects(
    new BusApiClient(options, async () => {
      calls++;
      return new Response("secret", { status: 403 });
    }).postEvent(event),
    /^Error: bus_auth_http_403$/,
  );
  assert.equal(calls, 1);
});
test("invalid token responses do not publish", async () => {
  await assert.rejects(
    new BusApiClient(options, async () =>
      Response.json({ error: "secret" }),
    ).postEvent(event),
    /bus_auth_invalid_response/,
  );
});
test("401 clears cached token; publication failure remains retryable", async () => {
  let auths = 0;
  const request: typeof fetch = async (url) => {
    if (url === options.AUTH0_URL) {
      auths++;
      return Response.json({ access_token: "token", expires_in: 3600 });
    }
    return new Response("secret", { status: 401 });
  };
  const client = new BusApiClient(options, request);
  await assert.rejects(client.postEvent(event), /bus_http_401/);
  await assert.rejects(client.postEvent(event), /bus_http_401/);
  assert.equal(auths, 2);
});
test("transport errors and aborts are sanitized", async () => {
  await assert.rejects(
    new BusApiClient(options, async () => {
      throw new Error("secret");
    }).postEvent(event),
    /^Error: bus_network_or_timeout$/,
  );
});
test("Bus config is optional when absent, but partial settings and non-v6 bases fail early", () => {
  const base = {
    DATABASE_URL: "postgresql://user:pass@localhost/db",
    KAFKA_URL: "localhost:9092",
  };
  assert.equal(config(base).busApi, undefined);
  assert.throws(
    () => config({ ...base, BUSAPI_URL: options.BUSAPI_URL }),
    /AUTH0_CLIENT_SECRET/,
  );
  assert.equal(
    config({ ...base, ...options, BUSAPI_URL: options.BUSAPI_URL + "/" }).busApi
      ?.BUSAPI_URL,
    options.BUSAPI_URL,
  );
  for (const url of [
    "https://example.com/v5",
    "https://example.com/v6/bus/events",
    "https://user:secret@example.com/v6",
    "https://example.com/v6?q=secret",
  ]) {
    assert.throws(
      () => config({ ...base, ...options, BUSAPI_URL: url }),
      /^Error: Invalid configuration: BUSAPI_URL$/,
    );
  }
});
