import type { BusConfig } from "./bus.js";
import { z } from "zod";
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
  M2M_PROVIDER: z.literal("keycloak").optional(),
  KEYCLOAK_ISSUER: z.string().optional(),
  KEYCLOAK_TOKEN_URL: z.string().optional(),
  KEYCLOAK_AUDIENCE: z.string().optional(),
  KEYCLOAK_CLIENT_ID: z.string().optional(),
  KEYCLOAK_CLIENT_SECRET: z.string().optional(),
  KEYCLOAK_SCOPE: z.string().optional(),
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
/** Validate startup environment (defaults to process.env), including all-or-none Keycloak Bus credentials and comma-separated sales recipients.
 * Returns normalized worker/Bus settings; missing email settings leave delivery deferred.
 * Throws with invalid variable names only, never secret values; used by main before opening connections.
 */
export function config(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success)
    throw new Error(
      `Invalid configuration: ${parsed.error.issues.map((x) => x.path.join(".")).join(", ")}`,
    );
  const data = parsed.data;
  const keys = [
    "BUSAPI_URL",
    "M2M_PROVIDER",
    "KEYCLOAK_ISSUER",
    "KEYCLOAK_TOKEN_URL",
    "KEYCLOAK_AUDIENCE",
    "KEYCLOAK_CLIENT_ID",
    "KEYCLOAK_CLIENT_SECRET",
  ] as const;
  if (!keys.some((key) => data[key]?.trim()) && !data.KEYCLOAK_SCOPE?.trim()) return data;
  const missing = keys.filter((key) => !data[key]?.trim());
  if (missing.length)
    throw new Error(`Invalid configuration: ${missing.join(", ")}`);
  const busApi = Object.fromEntries(
    keys.map((key) => [key, data[key]!.trim()]),
  ) as unknown as BusConfig;
  busApi.BUSAPI_URL = endpoint(busApi.BUSAPI_URL, "BUSAPI_URL", true);
  busApi.KEYCLOAK_ISSUER = endpoint(busApi.KEYCLOAK_ISSUER, "KEYCLOAK_ISSUER");
  busApi.KEYCLOAK_TOKEN_URL = endpoint(busApi.KEYCLOAK_TOKEN_URL, "KEYCLOAK_TOKEN_URL");
  if (data.KEYCLOAK_SCOPE?.trim()) busApi.KEYCLOAK_SCOPE = data.KEYCLOAK_SCOPE.trim();
  return { ...data, busApi };
}

/** Validate an HTTP(S) endpoint without credentials/query fragments; returns normalized URL or a safe error.
 * Bus API requires the /v6 base; Keycloak endpoints require HTTPS.
 */
function endpoint(value: string, key: string, bus = false): string {
  try {
    const url = new URL(value);
    url.pathname = url.pathname.replace(/\/+$/, "");
    if (
      !(bus ? ["http:", "https:"].includes(url.protocol) : url.protocol === "https:") ||
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
