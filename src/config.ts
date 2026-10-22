import type { AiConfig } from "./ai.js";
import type { BusConfig } from "./bus.js";
import { z } from "zod";
const boolean = z
  .enum(["true", "false"])
  .transform((value) => value === "true");
/** A comma-separated address list: trimmed, lower-cased, deduplicated; an empty entry inside a nonempty list fails. */
const emailList = (fallback: string) =>
  z
    .string()
    .trim()
    .default(fallback)
    .transform((value) =>
      value ? value.split(",").map((email) => email.trim().toLowerCase()) : [],
    )
    .pipe(z.array(z.email()).max(1000))
    .transform((emails) => [...new Set(emails)]);
/** A SendGrid dynamic template id, or empty while the template isn't set up (its flow then defers). */
const templateId = z
  .string()
  .trim()
  .regex(/^$|^d-[a-f0-9]{32}$/)
  .default("");
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
  LETS_TALK_RECIPIENTS: emailList(""),
  LETS_TALK_SENDGRID_TEMPLATE_ID: templateId,
  // AI classification (ADR 0001). AI_API_URL is the tc-ai-api base ending in /v6/ai.
  AI_API_URL: z.string().optional(),
  /** Token audience for tc-ai-api; defaults to AUTH0_AUDIENCE. */
  AI_AUTH0_AUDIENCE: z.string().optional(),
  LETS_TALK_CLASSIFY_MAX_ATTEMPTS: z.coerce
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5),
  LETS_TALK_CLASSIFY_MAX_AGE_MINUTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(10080)
    .default(30),
  // Label actions (ADR 0001, Decision 2): one SendGrid template per reply flow.
  LETS_TALK_OPPORTUNITY_TEMPLATE_ID: templateId,
  LETS_TALK_SKILLS_TEMPLATE_ID: templateId,
  LETS_TALK_GENERAL_TEMPLATE_ID: templateId,
  LETS_TALK_WIPRO_TEMPLATE_ID: templateId,
  LETS_TALK_SALES_REPLY_TEMPLATE_ID: templateId,
  LETS_TALK_SUPPORT_TEMPLATE_ID: templateId,
  LETS_TALK_SUPPORT_RECIPIENTS: emailList("support@topcoder.com"),
  /** First address: the sales reply's reply-to; the rest are copied (email-service-v6 takes one reply-to). */
  LETS_TALK_SALES_REPLY_TO: emailList(
    "kiril.kartunov@topcoder.com,ramzy@topcoder.com",
  ),
  LETS_TALK_REPLY_CAP_PER_DAY: z.coerce
    .number()
    .int()
    .min(0)
    .max(100)
    .default(1),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});
export type Config = z.infer<typeof schema> & {
  busApi?: BusConfig;
  aiApi?: AiConfig;
};
/** Validate startup environment (defaults to process.env), including comma-separated sales recipients.
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
    "AUTH0_URL",
    "AUTH0_AUDIENCE",
    "AUTH0_CLIENT_ID",
    "AUTH0_CLIENT_SECRET",
  ] as const;
  if (
    !keys.some((key) => data[key]?.trim()) &&
    !data.AUTH0_PROXY_SERVER_URL?.trim()
  ) {
    // The AI client needs the same M2M credentials.
    if (data.AI_API_URL?.trim())
      throw new Error(`Invalid configuration: ${keys.join(", ")}`);
    return data;
  }
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
  return { ...data, busApi, ...aiConfig(data, busApi) };
}

/** The AI client settings when AI_API_URL is set, reusing the Bus API M2M identity. */
function aiConfig(
  data: z.infer<typeof schema>,
  busApi: BusConfig,
): { aiApi?: AiConfig } {
  if (!data.AI_API_URL?.trim()) return {};
  const m2m = {
    AUTH0_URL: busApi.AUTH0_URL,
    AUTH0_AUDIENCE: busApi.AUTH0_AUDIENCE,
    AUTH0_CLIENT_ID: busApi.AUTH0_CLIENT_ID,
    AUTH0_CLIENT_SECRET: busApi.AUTH0_CLIENT_SECRET,
    ...(busApi.AUTH0_PROXY_SERVER_URL
      ? { AUTH0_PROXY_SERVER_URL: busApi.AUTH0_PROXY_SERVER_URL }
      : {}),
  };
  return {
    aiApi: {
      ...m2m,
      AUTH0_AUDIENCE: data.AI_AUTH0_AUDIENCE?.trim() || m2m.AUTH0_AUDIENCE,
      AI_API_URL: endpoint(data.AI_API_URL.trim(), "AI_API_URL", "/v6/ai"),
    },
  };
}

/** Validate an HTTP(S) endpoint without credentials/query fragments; returns normalized URL or a safe error.
 * Bus API requires the /v6 base because the client appends /bus/events; tc-ai-api requires /v6/ai.
 */
function endpoint(
  value: string,
  key: string,
  base: boolean | string = false,
): string {
  try {
    const url = new URL(value);
    url.pathname = url.pathname.replace(/\/+$/, "");
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (base && !url.pathname.endsWith(base === true ? "/v6" : base))
    )
      throw new Error();
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new Error(`Invalid configuration: ${key}`);
  }
}
