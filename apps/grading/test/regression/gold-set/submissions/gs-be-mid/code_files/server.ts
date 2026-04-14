import Fastify from "fastify";

// Mid-tier backend submission: works, could be tidier.
const app = Fastify({ logger: true });
app.get("/health", async () => ({ ok: true }));
app.post("/orders", async (request) => {
  const body = request.body as { item?: string };
  return { id: "ord-1", item: body.item ?? "unknown" };
});
app.listen({ port: 8080 });
