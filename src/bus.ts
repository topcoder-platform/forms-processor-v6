import { createBusApiClient, HttpError, type BusApiClient as SharedBusClient } from "tc-core-library-js";
/** Settings for the standard Topcoder OAuth client-credentials/Bus API endpoints. */
export interface BusConfig {
  BUSAPI_URL: string;
  AUTH0_URL: string;
  AUTH0_AUDIENCE: string;
  AUTH0_CLIENT_ID: string;
  AUTH0_CLIENT_SECRET: string;
  AUTH0_PROXY_SERVER_URL?: string;
}

/** Complete Bus API envelope; the payload is interpreted by the topic's consumer. */
export interface BusEvent {
  topic: string;
  originator: string;
  timestamp: string;
  "mime-type": "application/json";
  key: string;
  payload: Record<string, unknown>;
}
export interface EventPublisher {
  postEvent(event: BusEvent): Promise<void>;
}
/** Contains only a fixed operational code, never credentials or response bodies. */
export class BusError extends Error {}

/** Adapts the shared bus publisher to the processor's durable-delivery error contract. */
export class BusApiClient implements EventPublisher {
  private readonly client: SharedBusClient;

  /** Creates the shared publisher from config and an optional test transport/clock; throws for invalid config. */
  constructor(config: BusConfig, request: typeof fetch = fetch, now: () => number = Date.now) {
    void now;
    this.client = createBusApiClient({ ...config, fetch: request, timeoutMs: 7000 });
  }

  /** Publishes an envelope and resolves on acceptance; throws sanitized BusError on token or bus failure. */
  async postEvent(event: BusEvent): Promise<void> {
    try { await this.client.postEvent(event); }
    catch (error) {
      throw new BusError(error instanceof HttpError && error.status ? `bus_http_${error.status}` : 'bus_network_or_timeout');
    }
  }
}
