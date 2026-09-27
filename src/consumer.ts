import {
  Consumer,
  MessagesStreamModes,
  MessagesStreamFallbackModes,
  type Message,
} from "@platformatic/kafka";
import { InvalidEvent, parseEvent, type Submission } from "./contracts.js";
import { log } from "./store.js";
import type { Config } from "./config.js";

/** Persist a Kafka message then commit it; invalid envelopes are logged by offset and discarded.
 * Accepts a message and durable enqueue callback; commit/storage failures propagate without advancing later offsets.
 */
export async function ingest(
  message: Pick<Message, "value" | "topic" | "partition" | "offset" | "commit">,
  enqueue: (event: Submission) => Promise<void>,
): Promise<void> {
  let event: Submission;
  try {
    event = parseEvent(message.value);
  } catch (error) {
    if (!(error instanceof InvalidEvent)) throw error;
    log("invalid_event_discarded", {
      topic: message.topic,
      partition: message.partition,
      offset: String(message.offset),
    });
    await message.commit();
    return;
  }
  await enqueue(event);
  await message.commit();
}

/** Consume form.submitted until aborted; failures propagate so ECS can restart from committed offsets.
 * The caller supplies validated config, durable enqueue, and a shutdown signal; no email runs on this loop.
 */
export async function consume(
  config: Config,
  enqueue: (event: Submission) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  const consumer = new Consumer({
    clientId: "forms-processor-v6",
    groupId: config.KAFKA_GROUP_ID,
    bootstrapBrokers: config.KAFKA_URL,
    tls: config.KAFKA_SSL_ENABLED ? {} : undefined,
    autocommit: false,
    autocreateTopics: false,
    sessionTimeout: 60_000,
    heartbeatInterval: 3000,
    highWaterMark: 1,
  });
  try {
    const stream = await consumer.consume({
      topics: ["form.submitted"],
      autocommit: false,
      mode: MessagesStreamModes.COMMITTED,
      fallbackMode: config.KAFKA_FROM_BEGINNING
        ? MessagesStreamFallbackModes.EARLIEST
        : MessagesStreamFallbackModes.LATEST,
      highWaterMark: 1,
    });
    /** Close the stream on SIGTERM; errors are handled by the enclosing consume loop. */
    const stop = (): void => {
      void stream.close().catch(() => consumer.close(true));
    };
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    log("kafka_subscribed", {
      group: config.KAFKA_GROUP_ID,
      topic: "form.submitted",
    });
    try {
      for await (const message of stream) {
        if (signal.aborted) break;
        await ingest(message, enqueue);
      }
    } finally {
      signal.removeEventListener("abort", stop);
      await stream.close().catch(() => {});
    }
    if (!signal.aborted) throw new Error("kafka_stream_ended");
  } finally {
    await consumer.close(true);
  }
}
