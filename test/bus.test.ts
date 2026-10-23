import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import nock from "nock";
import {
  BusApiClient,
  type Auth0BusConfig,
  type BusEvent,
  type KeycloakBusConfig,
} from "../src/bus.js";
import { config } from "../src/config.js";
const options: KeycloakBusConfig = {
  BUSAPI_URL: "https://api.example.com/v6",
  USE_KEYCLOAK: "true",
  KEYCLOAK_ISSUER: "https://keycloak.example.com/realms/test",
  KEYCLOAK_TOKEN_URL: "https://keycloak.example.com/m2m/token",
  KEYCLOAK_AUDIENCE: "https://api.example.com",
  KEYCLOAK_CLIENT_ID: "client",
  KEYCLOAK_CLIENT_SECRET: "synthetic-secret",
  KEYCLOAK_SCOPE: "write:bus_api",
};
const keys=generateKeyPairSync("rsa",{modulusLength:2048});
const event: BusEvent = {topic:"external.action.email",originator:"forms-processor-v6",
  timestamp:new Date().toISOString(),"mime-type":"application/json",key:"id",payload:{version:"v3"}};

/** Signs local Keycloak test claims; returns a JWT; crypto/encoding failures propagate. */
function token(claims:Record<string,unknown>={}):string {
  const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString("base64url");
  const now=Math.floor(Date.now()/1000);
  const value=encode({alg:"RS256",kid:"processor-test"})+"."+encode({iss:options.KEYCLOAK_ISSUER,
    aud:options.KEYCLOAK_AUDIENCE,sub:"service-account",azp:"client",gty:"client-credentials",scope:"write:bus_api",
    iat:now,exp:now+300,...claims});
  return value+"."+sign("RSA-SHA256",Buffer.from(value),keys.privateKey).toString("base64url");
}
/** Installs a single managed endpoint response; returns its nock scope; no external network calls. */
function issuance(accessToken=token(),expiresIn=300) {
  return nock("https://keycloak.example.com").post("/m2m/token",body=>{
    assert.deepEqual(body,{grant_type:"client_credentials",client_id:"client",client_secret:"synthetic-secret",
      audience:options.KEYCLOAK_AUDIENCE,scope:"write:bus_api"});return true;
  }).reply(200,{access_token:accessToken,expires_in:expiresIn,token_type:"Bearer"});
}
beforeEach(()=>{
  nock("https://keycloak.example.com").persist().get("/realms/test/protocol/openid-connect/certs")
    .reply(200,{keys:[{...keys.publicKey.export({format:"jwk"}),kid:"processor-test",alg:"RS256",use:"sig"}]});
});
afterEach(()=>nock.cleanAll());

test("validates and caches Keycloak tokens before posting envelopes to the v6 Bus endpoint",async()=>{
  const accessToken=token();const auth=issuance(accessToken);let posts=0;
  const request:typeof fetch=async(url,init)=>{
    assert.equal(url,options.BUSAPI_URL+"/bus/events");assert.equal(init?.redirect,"error");assert.ok(init?.signal);
    assert.equal((init.headers as Record<string,string>).Authorization,"Bearer "+accessToken);
    assert.deepEqual(JSON.parse(String(init.body)),event);posts++;return new Response(null,{status:202});
  };
  const client=new BusApiClient(options,request);await client.postEvent(event);await client.postEvent(event);
  assert.equal(posts,2);assert.ok(auth.isDone());
});
test("authentication failures cannot publish or expose response bodies",async()=>{
  nock("https://keycloak.example.com").post("/m2m/token").reply(403,"sensitive response");let posts=0;
  await assert.rejects(new BusApiClient(options,async()=>{posts++;return new Response(null);}).postEvent(event),/^Error: bus_auth_failed$/);
  assert.equal(posts,0);
});
test("unverified, expired and wrong-client returned tokens cannot publish",async()=>{
  for(const value of ["not-a-jwt",token({exp:Math.floor(Date.now()/1000)-1}),token({azp:"other-client"})]) {
    issuance(value);let posts=0;
    await assert.rejects(new BusApiClient(options,async()=>{posts++;return new Response(null);}).postEvent(event),/bus_auth_failed/);
    assert.equal(posts,0);
  }
});
test("invalid token response lifetimes cannot publish",async()=>{
  issuance(token(),0);
  await assert.rejects(new BusApiClient(options,async()=>{throw new Error("should not publish");}).postEvent(event),/bus_auth_failed/);
});
test("401 clears the shared token cache before a retry",async()=>{
  const first=issuance();const second=issuance();
  const client=new BusApiClient(options,async()=>new Response("sensitive response",{status:401}));
  await assert.rejects(client.postEvent(event),/bus_http_401/);
  await assert.rejects(client.postEvent(event),/bus_http_401/);
  assert.ok(first.isDone());assert.ok(second.isDone());
});
test("transport errors are sanitized",async()=>{
  issuance();
  await assert.rejects(new BusApiClient(options,async()=>{throw new Error("sensitive transport detail");}).postEvent(event),/^Error: bus_network_or_timeout$/);
});
test("Bus config is optional, but partial settings, Auth0 selection and insecure issuer endpoints fail",()=>{
  const base={DATABASE_URL:"postgresql://user:pass@localhost/db",KAFKA_URL:"localhost:9092"};
  assert.equal(config(base).busApi,undefined);
  assert.equal(config({...base,USE_KEYCLOAK:"true"}).busApi,undefined);
  assert.throws(()=>config({...base,USE_KEYCLOAK:"true",BUSAPI_URL:options.BUSAPI_URL}),/KEYCLOAK_CLIENT_SECRET/);
  assert.equal(config({...base,...options,BUSAPI_URL:options.BUSAPI_URL+"/"}).busApi?.BUSAPI_URL,options.BUSAPI_URL);
  assert.deepEqual(config({...base,...options,...auth0Options}).busApi,options);
  assert.throws(()=>config({...base,...options,USE_KEYCLOAK:"auth0"}),/^Error: Invalid configuration: USE_KEYCLOAK$/);
  assert.throws(()=>config({...base,...options,KEYCLOAK_TOKEN_URL:"http://issuer.example/token"}),/KEYCLOAK_TOKEN_URL/);
  for(const url of ["https://example.com/v5","https://example.com/v6/bus/events","https://user:secret@example.com/v6","https://example.com/v6?q=secret"])
    assert.throws(()=>config({...base,...options,BUSAPI_URL:url}),/^Error: Invalid configuration: BUSAPI_URL$/);
});

// USE_KEYCLOAK unset or false: the pre-migration Auth0 client-credentials path.
const auth0Options: Auth0BusConfig = {
  BUSAPI_URL: "https://api.example.com/v6",
  AUTH0_URL: "https://auth.example.com/oauth/token",
  AUTH0_AUDIENCE: "https://example.com",
  AUTH0_CLIENT_ID: "client",
  AUTH0_CLIENT_SECRET: "secret",
};

test("Auth0: requests/caches M2M tokens and posts the envelope to the v6 Bus endpoint", async () => {
  let tokenRequests = 0;
  let posts = 0;
  let now = 100000;
  const request: typeof fetch = async (url, init) => {
    assert.ok(init?.signal);
    assert.equal(init.redirect, "error");
    if (url === auth0Options.AUTH0_URL) {
      tokenRequests++;
      assert.deepEqual(JSON.parse(String(init.body)), {
        grant_type: "client_credentials",
        client_id: "client",
        client_secret: "secret",
        audience: auth0Options.AUTH0_AUDIENCE,
        auth0_url: auth0Options.AUTH0_URL,
      });
      return Response.json({ access_token: "token", expires_in: 120 });
    }
    posts++;
    assert.equal(url, auth0Options.BUSAPI_URL + "/bus/events");
    assert.equal(
      (init.headers as Record<string, string>).Authorization,
      "Bearer token",
    );
    assert.deepEqual(JSON.parse(String(init.body)), event);
    return new Response(null, { status: 202 });
  };
  const client = new BusApiClient(auth0Options, request, () => now);
  await client.postEvent(event);
  await client.postEvent(event);
  assert.equal(tokenRequests, 1);
  assert.equal(posts, 2);
  now += 61000;
  await client.postEvent(event);
  assert.equal(tokenRequests, 2);
});
test("Auth0: supports the standard Auth0 proxy endpoint and auth0_url field", async () => {
  const proxy = "https://proxy.example.com/token";
  const request: typeof fetch = async (url, init) => {
    if (url === proxy) {
      assert.equal(JSON.parse(String(init?.body)).auth0_url, auth0Options.AUTH0_URL);
      return Response.json({ access_token: "token" });
    }
    assert.equal(url, auth0Options.BUSAPI_URL + "/bus/events");
    return new Response(null, { status: 204 });
  };
  await new BusApiClient(
    { ...auth0Options, AUTH0_PROXY_SERVER_URL: proxy },
    request,
  ).postEvent(event);
});
test("Auth0: authentication failure prevents Bus publication and never exposes response text", async () => {
  let calls = 0;
  await assert.rejects(
    new BusApiClient(auth0Options, async () => {
      calls++;
      return new Response("secret", { status: 403 });
    }).postEvent(event),
    /^Error: bus_auth_http_403$/,
  );
  assert.equal(calls, 1);
});
test("Auth0: invalid token responses do not publish", async () => {
  await assert.rejects(
    new BusApiClient(auth0Options, async () =>
      Response.json({ error: "secret" }),
    ).postEvent(event),
    /bus_auth_invalid_response/,
  );
});
test("Auth0: 401 clears cached token; publication failure remains retryable", async () => {
  let auths = 0;
  const request: typeof fetch = async (url) => {
    if (url === auth0Options.AUTH0_URL) {
      auths++;
      return Response.json({ access_token: "token", expires_in: 3600 });
    }
    return new Response("secret", { status: 401 });
  };
  const client = new BusApiClient({ ...auth0Options, USE_KEYCLOAK: "false" }, request);
  await assert.rejects(client.postEvent(event), /bus_http_401/);
  await assert.rejects(client.postEvent(event), /bus_http_401/);
  assert.equal(auths, 2);
});
test("Auth0: Bus config is selected when USE_KEYCLOAK is unset or false and ignores Keycloak settings", () => {
  const base = {
    DATABASE_URL: "postgresql://user:pass@localhost/db",
    KAFKA_URL: "localhost:9092",
  };
  assert.throws(
    () => config({ ...base, BUSAPI_URL: auth0Options.BUSAPI_URL }),
    /AUTH0_CLIENT_SECRET/,
  );
  for (const USE_KEYCLOAK of [undefined, "", "false", "FALSE"]) {
    assert.deepEqual(
      config({ ...base, ...options, ...auth0Options, USE_KEYCLOAK }).busApi,
      auth0Options,
    );
  }
  const local = config({
    ...base,
    ...auth0Options,
    AUTH0_URL: "http://localhost:4000/v5/auth0",
  }).busApi as Auth0BusConfig;
  assert.equal(local.AUTH0_URL, "http://localhost:4000/v5/auth0");
  assert.throws(
    () => config({ ...base, ...options, USE_KEYCLOAK: "false" }),
    /AUTH0_URL, AUTH0_AUDIENCE, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET/,
  );
});
