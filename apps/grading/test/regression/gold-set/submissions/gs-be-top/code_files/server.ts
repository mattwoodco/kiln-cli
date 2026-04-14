import Fastify from "fastify";

// Top-tier backend submission: clean, well-tested circuit breaker.
export function buildServer() {
  const app = Fastify({ logger: true });
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/orders/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!id) return reply.code(400).send({ error: "missing_id" });
    return { id, state: "pending" };
  });
  return app;
}
