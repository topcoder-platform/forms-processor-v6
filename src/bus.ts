import { AuthError, M2MTokenProvider, type M2MConfig } from "./auth.js";

/** Settings for the standard Topcoder OAuth client-credentials/Bus API endpoints. */
export interface BusConfig extends M2MConfig {
  BUSAPI_URL: string;
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

/** Publishes authenticated Bus API events with bounded, abortable requests and cached M2M tokens.
 * Uses the same client-credentials and auth0_url proxy contract as tc-core-library-js.
 */
export class BusApiClient implements EventPublisher {
  private readonly tokens: M2MTokenProvider;
  /** Accepts validated settings and optional HTTP/clock dependencies; performs no network requests. */
  constructor(
    private readonly config: BusConfig,
    private readonly request: typeof fetch = fetch,
    now: () => number = Date.now,
  ) {
    this.tokens = new M2MTokenProvider(config, request, now);
  }

  /** Publish an envelope to /bus/events; resolves on HTTP acceptance or throws a sanitized BusError.
   * Token acquisition and publication share a 15-second deadline, below the database lock timeout.
   */
  async postEvent(event: BusEvent): Promise<void> {
    const signal = AbortSignal.timeout(15_000);
    try {
      const token = await this.tokens.get(signal);
      const response = await this.request(
        `${this.config.BUSAPI_URL}/bus/events`,
        {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(event),
        },
      );
      await response.body?.cancel().catch(() => {});
      if (response.status === 401) this.tokens.invalidate();
      if (!response.ok) throw new BusError(`bus_http_${response.status}`);
    } catch (error) {
      if (error instanceof BusError) throw error;
      if (error instanceof AuthError)
        throw new BusError(`bus_${error.message}`);
      throw new BusError("bus_network_or_timeout");
    }
  }
}
