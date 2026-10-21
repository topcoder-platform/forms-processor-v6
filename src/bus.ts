import { createRequire } from "node:module";
import type * as Core from "tc-core-library-js";
const require = createRequire(import.meta.url);
const { auth } = require("tc-core-library-js") as typeof Core;

/** Explicit Keycloak workload settings and the Bus API endpoint. */
export interface BusConfig {
  BUSAPI_URL: string;
  M2M_PROVIDER: "keycloak";
  KEYCLOAK_ISSUER: string;
  KEYCLOAK_TOKEN_URL: string;
  KEYCLOAK_AUDIENCE: string;
  KEYCLOAK_CLIENT_ID: string;
  KEYCLOAK_CLIENT_SECRET: string;
  KEYCLOAK_SCOPE?: string;
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
 * Shared core owns issuance, RSA validation and caching; no Auth0 fallback is available.
 */
export class BusApiClient implements EventPublisher {
  private readonly m2m: ReturnType<typeof auth.m2m>;
  /** Accepts Keycloak settings and an optional Bus HTTP dependency; invalid configuration throws; no network requests. */
  constructor(
    private readonly config: BusConfig,
    private readonly request: typeof fetch = fetch,
  ) {
    this.m2m = auth.m2m({ ...config });
  }

  /** Publish an envelope to /bus/events; resolves on HTTP acceptance or throws a sanitized BusError.
   * Token acquisition and publication share a 15-second deadline, below the database lock timeout.
   */
  async postEvent(event: BusEvent): Promise<void> {
    const signal = AbortSignal.timeout(15_000);
    try {
      const token = await this.getToken(signal);
      signal.throwIfAborted();
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
      if (response.status === 401) this.m2m.clearCache();
      if (!response.ok) throw new BusError(`bus_http_${response.status}`);
    } catch (error) {
      if (error instanceof BusError) throw error;
      throw new BusError("bus_network_or_timeout");
    }
  }

  /**
   * Waits for a verified shared-core token within the publication deadline.
   * @param signal Shared 15-second deadline. @returns Verified bearer token.
   * @throws Sanitized BusError on issuance or timeout; a late result cannot publish an event.
   * Core's own bounded request may finish/cache after this waiter stops, without holding the DB lock.
   */
  private getToken(signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(new BusError("bus_auth_timeout"));
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
      this.m2m.getMachineToken().then(
        (token) => {
          signal.removeEventListener("abort", abort);
          resolve(token);
        },
        () => {
          signal.removeEventListener("abort", abort);
          reject(new BusError("bus_auth_failed"));
        },
      );
    });
  }
}
