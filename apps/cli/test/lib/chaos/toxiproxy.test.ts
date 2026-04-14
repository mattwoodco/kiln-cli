import { describe, expect, it } from "vitest";
import { ToxiproxyClient } from "../../../src/lib/chaos/toxiproxy.js";

interface Call {
  url: string;
  method: string;
  body?: unknown;
}

function makeFetch(handler: (url: string, init: RequestInit) => Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init: RequestInit = {}): Promise<Response> => {
    const urlStr = typeof url === "string" ? url : url.toString();
    calls.push({
      url: urlStr,
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    return handler(urlStr, init);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ToxiproxyClient.listProxies", () => {
  it("unwraps the dict-shaped response", async () => {
    const { fetchImpl } = makeFetch(async () =>
      jsonResponse({
        api: {
          name: "api",
          listen: "127.0.0.1:5501",
          upstream: "127.0.0.1:9100",
          enabled: true,
        },
      }),
    );
    const client = new ToxiproxyClient({ fetchImpl, baseUrl: "http://tp:8474" });
    const proxies = await client.listProxies();
    expect(proxies).toHaveLength(1);
    expect(proxies[0]?.name).toBe("api");
  });
});

describe("ToxiproxyClient.addLatency", () => {
  it("POSTs to /proxies/:name/toxics with the right body", async () => {
    const { fetchImpl, calls } = makeFetch(async () =>
      jsonResponse({
        name: "latency-500ms",
        type: "latency",
        stream: "downstream",
        toxicity: 1,
        attributes: { latency: 500, jitter: 100 },
      }),
    );
    const client = new ToxiproxyClient({ fetchImpl });
    const toxic = await client.addLatency("api", 500, 100);
    expect(toxic.type).toBe("latency");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/proxies/api/toxics");
    const body = calls[0]?.body as { attributes: { latency: number; jitter: number } };
    expect(body.attributes.latency).toBe(500);
    expect(body.attributes.jitter).toBe(100);
  });
});

describe("ToxiproxyClient.addDisconnect", () => {
  it("disables, sleeps, and re-enables the proxy", async () => {
    const { fetchImpl, calls } = makeFetch(async () => jsonResponse({ enabled: true }));
    const client = new ToxiproxyClient({ fetchImpl });
    await client.addDisconnect("api", 1, async () => {});
    // Expect two POSTs to /proxies/api — enabled:false then enabled:true
    const postCalls = calls.filter((c) => c.url.endsWith("/proxies/api"));
    expect(postCalls).toHaveLength(2);
    const first = postCalls[0]?.body as { enabled: boolean };
    const second = postCalls[1]?.body as { enabled: boolean };
    expect(first.enabled).toBe(false);
    expect(second.enabled).toBe(true);
  });
});

describe("ToxiproxyClient error handling", () => {
  it("wraps network errors in a KilnError with a fix", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const client = new ToxiproxyClient({ fetchImpl });
    await expect(client.listProxies()).rejects.toThrow(/Toxiproxy unreachable/);
  });

  it("wraps non-2xx responses in a KilnError", async () => {
    const { fetchImpl } = makeFetch(async () => new Response("nope", { status: 500 }));
    const client = new ToxiproxyClient({ fetchImpl });
    await expect(client.listProxies()).rejects.toThrow(/HTTP 500/);
  });
});

describe("ToxiproxyClient.removeAll", () => {
  it("deletes every toxic on every proxy", async () => {
    const { fetchImpl, calls } = makeFetch(async (url, init) => {
      if (url.endsWith("/proxies") && (init.method ?? "GET") === "GET") {
        return jsonResponse({
          api: { name: "api", listen: "", upstream: "", enabled: true },
        });
      }
      if (url.endsWith("/proxies/api/toxics") && (init.method ?? "GET") === "GET") {
        return jsonResponse([
          { name: "lat", type: "latency", stream: "downstream", toxicity: 1, attributes: {} },
        ]);
      }
      if (url.endsWith("/proxies/api/toxics/lat") && init.method === "DELETE") {
        return new Response(null, { status: 200 });
      }
      return jsonResponse({});
    });
    const client = new ToxiproxyClient({ fetchImpl });
    await client.removeAll();
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });
});
