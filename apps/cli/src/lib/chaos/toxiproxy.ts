/**
 * Toxiproxy REST client.
 *
 * Targets the HTTP control API on TOXIPROXY_URL (default http://localhost:8474).
 * Methods map 1:1 onto the features we use in Phase 4 chaos experiments:
 * latency injection, full upstream disconnect, listing, and bulk cleanup.
 *
 * All errors are wrapped in KilnError so command handlers get a `fix` hint.
 */

import { KilnError } from "../errors.js";

export interface ToxiproxyProxy {
  name: string;
  listen: string;
  upstream: string;
  enabled: boolean;
}

export interface ToxiproxyToxic {
  name: string;
  type: string;
  stream: "upstream" | "downstream";
  toxicity: number;
  attributes: Record<string, unknown>;
}

export interface ToxiproxyClientOptions {
  /** Base URL; default http://localhost:8474 or TOXIPROXY_URL env. */
  baseUrl?: string;
  /** Injectable fetch implementation. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms (default 3000). */
  requestTimeoutMs?: number;
}

function defaultBaseUrl(): string {
  return process.env.TOXIPROXY_URL ?? "http://localhost:8474";
}

export class ToxiproxyClient {
  public readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: ToxiproxyClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? defaultBaseUrl()).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 3000;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const init: RequestInit = {
        method,
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
      };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }
      const res = await this.fetchImpl(url, init);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new KilnError(`Toxiproxy ${method} ${path} → HTTP ${res.status}: ${text}`, {
          fix: "docker run -d -p 8474:8474 -p 5500-5511:5500-5511 shopify/toxiproxy",
          code: "TOXIPROXY_HTTP",
        });
      }
      // 204 No Content — e.g. DELETE /proxies/foo/toxics/bar.
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      if (text === "") return undefined as T;
      return JSON.parse(text) as T;
    } catch (err) {
      if (err instanceof KilnError) throw err;
      throw new KilnError(
        `Toxiproxy unreachable at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
        {
          fix: "docker run -d -p 8474:8474 -p 5500-5511:5500-5511 shopify/toxiproxy",
          code: "TOXIPROXY_UNREACHABLE",
          cause: err,
        },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async listProxies(): Promise<ToxiproxyProxy[]> {
    const raw = await this.request<Record<string, ToxiproxyProxy>>("GET", "/proxies");
    return Object.values(raw ?? {});
  }

  /** Idempotent create: if the proxy already exists, leave it alone. */
  async createProxy(name: string, listen: string, upstream: string): Promise<ToxiproxyProxy> {
    const existing = await this.listProxies();
    const match = existing.find((p) => p.name === name);
    if (match) return match;
    return this.request<ToxiproxyProxy>("POST", "/proxies", {
      name,
      listen,
      upstream,
      enabled: true,
    });
  }

  async addLatency(proxy: string, latencyMs: number, jitterMs: number): Promise<ToxiproxyToxic> {
    return this.request<ToxiproxyToxic>("POST", `/proxies/${proxy}/toxics`, {
      name: `latency-${latencyMs}ms`,
      type: "latency",
      stream: "downstream",
      toxicity: 1.0,
      attributes: { latency: latencyMs, jitter: jitterMs },
    });
  }

  /**
   * "Disconnect" by disabling the proxy, sleeping for `durationSeconds`,
   * then re-enabling it. This mirrors a hard upstream outage.
   * Exposed as a single call so commands don't juggle state themselves.
   */
  async addDisconnect(
    proxy: string,
    durationSeconds: number,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ): Promise<void> {
    await this.request("POST", `/proxies/${proxy}`, { enabled: false });
    try {
      await sleep(durationSeconds * 1000);
    } finally {
      await this.request("POST", `/proxies/${proxy}`, { enabled: true });
    }
  }

  /** Delete every toxic on every proxy. Useful for post-experiment cleanup. */
  async removeAll(): Promise<void> {
    const proxies = await this.listProxies();
    for (const p of proxies) {
      const toxics = await this.request<ToxiproxyToxic[]>("GET", `/proxies/${p.name}/toxics`);
      for (const t of toxics ?? []) {
        await this.request("DELETE", `/proxies/${p.name}/toxics/${t.name}`);
      }
    }
  }
}
