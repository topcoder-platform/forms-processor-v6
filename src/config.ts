import { createRequire } from "node:module";
import type * as Core from "tc-core-library-js";
import type { Auth0BusConfig, BusConfig, KeycloakBusConfig } from "./bus.js";
import { z } from "zod";
const require = createRequire(import.meta.url);
const { auth } = require("tc-core-library-js") as typeof Core;
const boolean = z
  .enum(["true", "false"])
  .transform((value) => value === "true");
const schema = z.object({
  DATABASE_URL: z.string().url(),
  KAFKA_URL: z
    .string()
    .min(1)
    .transform((value) => value.split(",").map((x) => x.trim()))
    .pipe(z.array(z.string().min(1)).min(1)),
  KAFKA_GROUP_ID: z.string().min(1).default("forms-processor-v6"),
  KAFKA_SSL_ENABLED: boolean.default(false),
  KAFKA_FROM_BEGINNING: boolean.default(true),
  BUSAPI_URL: z.string().optional(),
  // Validated by tc-core-library-js (auth.useKeycloak) in config().
  USE_KEYCLOAK: z.string().optional(),
  KEYCLOAK_ISSUER: z.string().optional(),
  KEYCLOAK_TOKEN_URL: z.string().optional(),
  KEYCLOAK_AUDIENCE: z.string().optional(),
  KEYCLOAK_CLIENT_ID: z.string().optional(),
  KEYCLOAK_CLIENT_SECRET: z.string().optional(),
  KEYCLOAK_SCOPE: z.string().optional(),
  AUTH0_URL: z.string().optional(),
  AUTH0_AUDIENCE: z.string().optional(),
  AUTH0_CLIENT_ID: z.string().optional(),
  AUTH0_CLIENT_SECRET: z.string().optional(),
  AUTH0_PROXY_SERVER_URL: z.string().optional(),
  LETS_TALK_RECIPIENTS: z
    .string()
    .trim()
    .default("")
    .transform((value) =>
      value ? value.split(",").map((email) => email.trim().toLowerCase()) : [],
    )
    .pipe(z.array(z.email()).max(1000))
    .transform((emails) => [...new Set(emails)]),
  LETS_TALK_SENDGRID_TEMPLATE_ID: z
    .string()
    .trim()
    .regex(/^$|^d-[a-f0-9]{32}$/)
    .default(""),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});
export type Config = z.infer<typeof schema> & { busApi?: BusConfig };
/** Validate startup environment (defaults to process.env), including all-or-none Bus credentials and comma-separated sales recipients.
 * USE_KEYCLOAK (decided by tc-core-library-js) selects the Bus credential set: true requires the
 * Keycloak issuer, HTTPS token URL, audience and client credentials (optional KEYCLOAK_SCOPE);
 * unset or false requires the pre-migration AUTH0_URL, AUTH0_AUDIENCE, AUTH0_CLIENT_ID and
 * AUTH0_CLIENT_SECRET (optional AUTH0_PROXY_SERVER_URL). The other provider's settings are ignored.
 * Returns normalized worker/Bus settings; missing email settings leave delivery deferred.
 * Throws with invalid variable names only, never secret values (including an invalid
 * USE_KEYCLOAK); used by main before opening connections.
 */
export function config(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success)
    throw new Error(
      `Invalid configuration: ${parsed.error.issues.map((x) => x.path.join(".")).join(", ")}`,
    );
  const data = parsed.data;
  let keycloak: boolean;
  try {
    keycloak = auth.useKeycloak({ USE_KEYCLOAK: data.USE_KEYCLOAK });
  } catch {
    throw new Error("Invalid configuration: USE_KEYCLOAK");
  }
  return keycloak ? keycloakBus(data) : auth0Bus(data);
}

type Settings = z.infer<typeof schema>;

/** Apply the all-or-none Keycloak Bus rules for config() when USE_KEYCLOAK=true.
 * Takes parsed settings; returns them with busApi when any Keycloak Bus setting is present.
 * Throws naming missing or invalid variables; Keycloak endpoints must be HTTPS.
 */
function keycloakBus(data: Settings): Config {
  const keys = [
    "BUSAPI_URL",
    "KEYCLOAK_ISSUER",
    "KEYCLOAK_TOKEN_URL",
    "KEYCLOAK_AUDIENCE",
    "KEYCLOAK_CLIENT_ID",
    "KEYCLOAK_CLIENT_SECRET",
  ] as const;
  if (!keys.some((key) => data[key]?.trim()) && !data.KEYCLOAK_SCOPE?.trim())
    return data;
  const missing = keys.filter((key) => !data[key]?.trim());
  if (missing.length)
    throw new Error(`Invalid configuration: ${missing.join(", ")}`);
  const busApi = {
    ...Object.fromEntries(keys.map((key) => [key, data[key]!.trim()])),
    USE_KEYCLOAK: "true",
  } as unknown as KeycloakBusConfig;
  busApi.BUSAPI_URL = endpoint(busApi.BUSAPI_URL, "BUSAPI_URL", true);
  busApi.KEYCLOAK_ISSUER = endpoint(
    busApi.KEYCLOAK_ISSUER,
    "KEYCLOAK_ISSUER",
    false,
    true,
  );
  busApi.KEYCLOAK_TOKEN_URL = endpoint(
    busApi.KEYCLOAK_TOKEN_URL,
    "KEYCLOAK_TOKEN_URL",
    false,
    true,
  );
  if (data.KEYCLOAK_SCOPE?.trim())
    busApi.KEYCLOAK_SCOPE = data.KEYCLOAK_SCOPE.trim();
  return { ...data, busApi };
}

/** Apply the pre-migration all-or-none Auth0 Bus rules for config() when USE_KEYCLOAK is unset or false.
 * Takes parsed settings; returns them with busApi when any Auth0 Bus setting is present.
 * Throws naming missing or invalid variables; Auth0 endpoints may be HTTP(S).
 */
function auth0Bus(data: Settings): Config {
  const keys = [
    "BUSAPI_URL",
    "AUTH0_URL",
    "AUTH0_AUDIENCE",
    "AUTH0_CLIENT_ID",
    "AUTH0_CLIENT_SECRET",
  ] as const;
  if (
    !keys.some((key) => data[key]?.trim()) &&
    !data.AUTH0_PROXY_SERVER_URL?.trim()
  )
    return data;
  const missing = keys.filter((key) => !data[key]?.trim());
  if (missing.length)
    throw new Error(`Invalid configuration: ${missing.join(", ")}`);
  const busApi = Object.fromEntries(
    keys.map((key) => [key, data[key]!.trim()]),
  ) as unknown as Auth0BusConfig;
  busApi.BUSAPI_URL = endpoint(busApi.BUSAPI_URL, "BUSAPI_URL", true);
  busApi.AUTH0_URL = endpoint(busApi.AUTH0_URL, "AUTH0_URL");
  if (data.AUTH0_PROXY_SERVER_URL?.trim())
    busApi.AUTH0_PROXY_SERVER_URL = endpoint(
      data.AUTH0_PROXY_SERVER_URL.trim(),
      "AUTH0_PROXY_SERVER_URL",
    );
  return { ...data, busApi };
}

/** Validate an HTTP(S) endpoint without credentials/query fragments; returns normalized URL or a safe error.
 * Bus API requires the /v6 base; Keycloak endpoints (https = true) require HTTPS; Auth0
 * endpoints accept HTTP(S) as before the migration.
 */
function endpoint(
  value: string,
  key: string,
  bus = false,
  https = false,
): string {
  try {
    const url = new URL(value);
    url.pathname = url.pathname.replace(/\/+$/, "");
    if (
      !(https
        ? url.protocol === "https:"
        : ["http:", "https:"].includes(url.protocol)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (bus && !url.pathname.endsWith("/v6"))
    )
      throw new Error();
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new Error(`Invalid configuration: ${key}`);
  }
}
