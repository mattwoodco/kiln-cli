import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Dev-only JWT claims. The plan calls for real auth in a later phase —
 * for MVP we issue unsigned dev tokens to any known user email.
 *
 * DEFERRED: real password auth, refresh tokens, OAuth. See PROGRESS.md.
 */
export interface KilnJwtPayload {
  userId: string;
  cohortId: string;
  role: "student" | "grader" | "admin";
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: KilnJwtPayload;
    user: KilnJwtPayload;
  }
}

export interface CohortScope {
  userId: string;
  cohortId: string;
  role: "student" | "grader" | "admin";
}

export async function requireCohortScope(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<CohortScope | null> {
  try {
    await request.jwtVerify();
  } catch {
    await reply.code(401).send({ error: "unauthorized" });
    return null;
  }
  const user = request.user;
  return { userId: user.userId, cohortId: user.cohortId, role: user.role };
}

export async function requireRole(
  request: FastifyRequest,
  reply: FastifyReply,
  roles: ReadonlyArray<"student" | "grader" | "admin">,
): Promise<CohortScope | null> {
  const scope = await requireCohortScope(request, reply);
  if (!scope) return null;
  if (!roles.includes(scope.role)) {
    await reply.code(403).send({ error: "forbidden" });
    return null;
  }
  return scope;
}

/**
 * Enforce that a cohort-scoped resource belongs to the caller's cohort.
 * Returns the scope if allowed, or replies 403 and returns null.
 */
export async function assertCohortMatch(
  reply: FastifyReply,
  scope: CohortScope,
  resourceCohortId: string,
): Promise<boolean> {
  if (scope.role === "admin") return true;
  if (scope.cohortId !== resourceCohortId) {
    await reply.code(403).send({ error: "cohort_scope_violation" });
    return false;
  }
  return true;
}
