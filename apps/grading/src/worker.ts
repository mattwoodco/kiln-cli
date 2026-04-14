import path from "node:path";
import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities/index.js";

/**
 * Temporal worker bootstrap for the grading task queue.
 *
 * Registers:
 *   - workflows: grade-submission
 *   - activities: clone, build, test, normalize, analyze, generate, store
 *
 * When Temporal is unreachable, the worker logs a warning and exits 0 so
 * CI typecheck+lint still pass on machines without the cluster running.
 */

export const GRADING_TASK_QUEUE = "grading";

export async function startWorker(): Promise<void> {
  const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  let connection: NativeConnection;
  try {
    connection = await NativeConnection.connect({ address });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[grading] Temporal unreachable at ${address} (${(err as Error).message}); worker will not start.`,
    );
    return;
  }

  const workflowsPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "workflows");

  const worker = await Worker.create({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? "default",
    taskQueue: GRADING_TASK_QUEUE,
    workflowsPath,
    activities,
  });

  // eslint-disable-next-line no-console
  console.log(`[grading] worker listening on ${address} / queue=${GRADING_TASK_QUEUE}`);
  await worker.run();
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("worker.ts") || entry.endsWith("worker.js")) {
  void startWorker();
}
