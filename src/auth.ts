/** Standard Topcoder OAuth client-credentials settings for one token audience. */
export interface M2MConfig {
  AUTH0_URL: string;
  AUTH0_AUDIENCE: string;
  AUTH0_CLIENT_ID: string;
  AUTH0_CLIENT_SECRET: string;
  AUTH0_PROXY_SERVER_URL?: string;
}

/** An authentication failure with a fixed code, never credentials or response bodies. */
export class AuthError extends Error {}

/** Requests and caches M2M tokens for one audience, using the same client-credentials and
 * auth0_url proxy contract as tc-core-library-js. Shared by the Bus API and AI API clients.
 */
export class M2MTokenProvider {
  private token?: { value: string; expiresAt: number };
  /** Accepts validated settings and optional HTTP/clock dependencies; performs no network requests. */
  constructor(
    private readonly config: M2MConfig,
    private readonly request: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** Drop the cached token, e.g. after a 401; takes and returns nothing. */
  invalidate(): void {
    this.token = undefined;
  }

  /** Get a cached token or request one with the caller's deadline; throws sanitized AuthErrors.
   * Cache only responses with a valid expires_in, refreshing 60 seconds before expiry.
   */
  async get(signal: AbortSignal): Promise<string> {
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
      throw new AuthError(`auth_http_${response.status}`);
    }
    const body: unknown = await response.json();
    if (
      !body ||
      typeof body !== "object" ||
      !("access_token" in body) ||
      typeof body.access_token !== "string" ||
      !body.access_token
    )
      throw new AuthError("auth_invalid_response");
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
