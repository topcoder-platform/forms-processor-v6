import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import nock from "nock";
import { BusApiClient, type BusConfig, type BusEvent } from "../src/bus.js";
import { config } from "../src/config.js";
const options: BusConfig = {
  BUSAPI_URL: "https://api.example.com/v6",
  M2M_PROVIDER: "keycloak",
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
  assert.throws(()=>config({...base,BUSAPI_URL:options.BUSAPI_URL}),/KEYCLOAK_CLIENT_SECRET/);
  assert.equal(config({...base,...options,BUSAPI_URL:options.BUSAPI_URL+"/"}).busApi?.BUSAPI_URL,options.BUSAPI_URL);
  assert.throws(()=>config({...base,...options,M2M_PROVIDER:"auth0"}),/M2M_PROVIDER/);
  assert.throws(()=>config({...base,...options,KEYCLOAK_TOKEN_URL:"http://issuer.example/token"}),/KEYCLOAK_TOKEN_URL/);
  for(const url of ["https://example.com/v5","https://example.com/v6/bus/events","https://user:secret@example.com/v6","https://example.com/v6?q=secret"])
    assert.throws(()=>config({...base,...options,BUSAPI_URL:url}),/^Error: Invalid configuration: BUSAPI_URL$/);
});
