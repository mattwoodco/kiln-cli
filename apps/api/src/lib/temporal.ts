import { Client, Connection, type WorkflowHandle } from "@temporalio/client";

/**
 * Lazily-connected Temporal client. If Temporal is unreachable we keep the
 * API alive and return 503 from endpoints that try to start/query workflows.
 */

let cachedClient: Client | null = null;
let connectionError: Error | null = null;

export const GRADING_TASK_QUEUE = "grading";
export const GRADE_SUBMISSION_WORKFLOW = "gradeSubmission";
export const CHECKPOINT_SUBMISSION_WORKFLOW = "checkpointSubmission";

export async function getTemporalClient(): Promise<Client | null> {
  if (cachedClient) return cachedClient;
  if (connectionError) return null;
  const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  try {
    const connection = await Connection.connect({ address });
    cachedClient = new Client({ connection });
    return cachedClient;
  } catch (err) {
    connectionError = err as Error;
    // eslint-disable-next-line no-console
    console.warn(`[api] Temporal unreachable at ${address}: ${(err as Error).message}`);
    return null;
  }
}

export function resetTemporalClient(): void {
  cachedClient = null;
  connectionError = null;
}

export async function describeWorkflow(workflowId: string): Promise<{
  status: string;
  handle: WorkflowHandle;
  runId: string | undefined;
} | null> {
  const client = await getTemporalClient();
  if (!client) return null;
  const handle = client.workflow.getHandle(workflowId);
  try {
    const desc = await handle.describe();
    return {
      status: String(desc.status.name),
      handle,
      runId: desc.runId,
    };
  } catch {
    return null;
  }
}
