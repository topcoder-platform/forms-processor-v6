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

/** Publishes authenticated Bus API events with bounded, abortable requests and cached M2M tokens.
 * Uses the same client-credentials and auth0_url proxy contract as tc-core-library-js.
 */
export class BusApiClient implements EventPublisher {
  private token?: { value: string; expiresAt: number };
  /** Accepts validated settings and optional HTTP/clock dependencies; performs no network requests. */
  constructor(
    private readonly config: BusConfig,
    private readonly request: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** Publish an envelope to /bus/events; resolves on HTTP acceptance or throws a sanitized BusError.
   * Token acquisition and publication share a 15-second deadline, below the database lock timeout.
   */
  async postEvent(event: BusEvent): Promise<void> {
    const signal = AbortSignal.timeout(15_000);
    try {
      const token = await this.getToken(signal);
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
      if (response.status === 401) this.token = undefined;
      if (!response.ok) throw new BusError(`bus_http_${response.status}`);
    } catch (error) {
      if (error instanceof BusError) throw error;
      throw new BusError("bus_network_or_timeout");
    }
  }

  /** Get a cached token or request one with the caller's deadline; throws sanitized auth errors.
   * Cache only responses with a valid expires_in, refreshing 60 seconds before expiry.
   */
  private async getToken(signal: AbortSignal): Promise<string> {
    if (this.token && this.token.expiresAt > this.now())
      return this.token.value;
    const config = this.config;
    const response = await this.request(
      config.AUTH0_PROXY_SERVER_URL || config.AUTH0_URL,
      {
        method: "POST",
        redirect: "error",
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "client_credentials",
          client_id: config.AUTH0_CLIENT_ID,
          client_secret: config.AUTH0_CLIENT_SECRET,
          audience: config.AUTH0_AUDIENCE,
          auth0_url: config.AUTH0_URL,
        }),
      },
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new BusError(`bus_auth_http_${response.status}`);
    }
    const body: unknown = await response.json();
    if (
      !body ||
      typeof body !== "object" ||
      !("access_token" in body) ||
      typeof body.access_token !== "string" ||
      !body.access_token
    )
      throw new BusError("bus_auth_invalid_response");
    const expires =
      "expires_in" in body &&
      typeof body.expires_in === "number" &&
      Number.isFinite(body.expires_in)
        ? body.expires_in
        : 0;
    this.token = {
      value: body.access_token,
      expiresAt: this.now() + Math.max(0, Math.min(expires, 86400) - 60) * 1000,
    };
    return body.access_token;
  }
}
