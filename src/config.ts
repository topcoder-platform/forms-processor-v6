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
  AUTH0_URL: z.string().optional(),
  AUTH0_AUDIENCE: z.string().optional(),
  AUTH0_CLIENT_ID: z.string().optional(),
  AUTH0_CLIENT_SECRET: z.string().optional(),
  AUTH0_PROXY_SERVER_URL: z.string().optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});
export type Config = z.infer<typeof schema> & { busApi?: BusConfig };
/** Validate environment settings at startup; returns config or throws with names only, never values. */
export function config(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success)
    throw new Error(
      `Invalid configuration: ${parsed.error.issues.map((x) => x.path.join(".")).join(", ")}`,
    );
  const data = parsed.data;
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
  ) as unknown as BusConfig;
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
 * Bus API requires the /v6 base because the client appends /bus/events.
 */
function endpoint(value: string, key: string, bus = false): string {
  try {
    const url = new URL(value);
    url.pathname = url.pathname.replace(/\/+$/, "");
    if (
      !["http:", "https:"].includes(url.protocol) ||
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
