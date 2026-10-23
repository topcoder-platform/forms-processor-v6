import { createRequire } from "node:module";
import type * as Core from "tc-core-library-js";
const require = createRequire(import.meta.url);
const { auth } = require("tc-core-library-js") as typeof Core;

/** Explicit Keycloak workload settings (USE_KEYCLOAK=true) and the Bus API endpoint. */
export interface KeycloakBusConfig {
  BUSAPI_URL: string;
  USE_KEYCLOAK: "true";
  KEYCLOAK_ISSUER: string;
  KEYCLOAK_TOKEN_URL: string;
  KEYCLOAK_AUDIENCE: string;
  KEYCLOAK_CLIENT_ID: string;
  KEYCLOAK_CLIENT_SECRET: string;
  KEYCLOAK_SCOPE?: string;
}

/** Settings for the standard Topcoder Auth0 client-credentials/Bus API endpoints (USE_KEYCLOAK unset or false). */
export interface Auth0BusConfig {
  BUSAPI_URL: string;
  USE_KEYCLOAK?: "false";
  AUTH0_URL: string;
  AUTH0_AUDIENCE: string;
  AUTH0_CLIENT_ID: string;
  AUTH0_CLIENT_SECRET: string;
  AUTH0_PROXY_SERVER_URL?: string;
}

/** Validated Bus settings for the M2M provider USE_KEYCLOAK selects; built by config(). */
export type BusConfig = KeycloakBusConfig | Auth0BusConfig;

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
 * USE_KEYCLOAK in the settings selects the token provider (decided by tc-core-library-js):
 * - true: the shared core owns Keycloak issuance, RSA validation and caching; it never
 *   falls back to Auth0.
 * - unset or false: the pre-migration Auth0 client-credentials request, using the same
 *   client-credentials and auth0_url proxy contract as tc-core-library-js.
 * Constructed by main when Bus settings are configured.
 */
export class BusApiClient implements EventPublisher {
  private readonly m2m?: ReturnType<typeof auth.m2m>;
  private token?: { value: string; expiresAt: number };
  /**
   * Accepts validated settings and optional HTTP/clock dependencies; performs no network requests.
   * @param config Bus settings from config(). @param request Fetch implementation for Bus (and Auth0) calls.
   * @param now Clock for the Auth0 token cache; unused in Keycloak mode.
   * @throws TypeError when USE_KEYCLOAK is invalid, or for invalid Keycloak settings in Keycloak mode.
   */
  constructor(
    private readonly config: BusConfig,
    private readonly request: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    if (auth.useKeycloak({ USE_KEYCLOAK: config.USE_KEYCLOAK }))
      this.m2m = auth.m2m({ ...config });
  }

  /** Publish an envelope to /bus/events; resolves on HTTP acceptance or throws a sanitized BusError.
   * Token acquisition and publication share a 15-second deadline, below the database lock timeout.
   * A Bus 401 clears the active provider's cached token so the next attempt requests a new one.
   */
  async postEvent(event: BusEvent): Promise<void> {
    const signal = AbortSignal.timeout(15_000);
    try {
      const token = this.m2m
        ? await this.getKeycloakToken(this.m2m, signal)
        : await this.getAuth0Token(signal);
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
      if (response.status === 401) {
        if (this.m2m) this.m2m.clearCache();
        else this.token = undefined;
      }
      if (!response.ok) throw new BusError(`bus_http_${response.status}`);
    } catch (error) {
      if (error instanceof BusError) throw error;
      throw new BusError("bus_network_or_timeout");
    }
  }

  /**
   * Waits for a verified shared-core Keycloak token within the publication deadline.
   * @param m2m Keycloak provider from auth.m2m. @param signal Shared 15-second deadline.
   * @returns Verified bearer token.
   * @throws Sanitized BusError on issuance or timeout; a late result cannot publish an event
   * (the deadline is checked again before publishing). Core's own bounded request may
   * finish/cache after this waiter stops, without holding the DB lock.
   */
  private async getKeycloakToken(
    m2m: ReturnType<typeof auth.m2m>,
    signal: AbortSignal,
  ): Promise<string> {
    const token = await new Promise<string>((resolve, reject) => {
      const abort = () => reject(new BusError("bus_auth_timeout"));
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
      m2m.getMachineToken().then(
        (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        () => {
          signal.removeEventListener("abort", abort);
          reject(new BusError("bus_auth_failed"));
        },
      );
    });
    signal.throwIfAborted();
    return token;
  }

  /** Get a cached Auth0 token or request one with the caller's deadline; throws sanitized auth errors.
   * Posts AUTH0_CLIENT_ID/SECRET, AUTH0_AUDIENCE and auth0_url to AUTH0_PROXY_SERVER_URL (default AUTH0_URL).
   * Cache only responses with a valid expires_in, refreshing 60 seconds before expiry.
   */
  private async getAuth0Token(signal: AbortSignal): Promise<string> {
    if (this.token && this.token.expiresAt > this.now())
      return this.token.value;
    const config = this.config as Auth0BusConfig;
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
