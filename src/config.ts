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
  SENDGRID_API_KEY: z.string().optional(),
  SENDGRID_SANDBOX: boolean.default(false),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});
export type Config = z.infer<typeof schema>;
/** Validate environment settings at startup; returns config or throws with names only, never values. */
export function config(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success)
    throw new Error(
      `Invalid configuration: ${parsed.error.issues.map((x) => x.path.join(".")).join(", ")}`,
    );
  return parsed.data;
}
