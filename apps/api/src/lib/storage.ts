import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Filesystem-backed artifact storage.
 *
 * Layout:
 *   {STORAGE_PATH}/cohorts/{cohortId}/{entityType}/{entityId}/{filename}
 *
 * STORAGE_PATH defaults to `./data`. In production on Fly this maps to a
 * mounted volume at `/data` (see execution plan §5, step 4).
 */

export type EntityType = "submissions" | "checkpoints";

function storageRoot(): string {
  return process.env.STORAGE_PATH ?? "./data";
}

function artifactDir(cohortId: string, entityType: EntityType, entityId: string): string {
  return path.join(storageRoot(), "cohorts", cohortId, entityType, entityId);
}

export async function storeArtifact(
  cohortId: string,
  entityType: EntityType,
  entityId: string,
  filename: string,
  content: Buffer | string,
): Promise<string> {
  const dir = artifactDir(cohortId, entityType, entityId);
  await mkdir(dir, { recursive: true });
  const fp = path.join(dir, filename);
  await writeFile(fp, content);
  return fp;
}

export async function readArtifact(
  cohortId: string,
  entityType: EntityType,
  entityId: string,
  filename: string,
): Promise<Buffer> {
  const fp = path.join(artifactDir(cohortId, entityType, entityId), filename);
  return readFile(fp);
}

export async function listArtifacts(
  cohortId: string,
  entityType: EntityType,
  entityId: string,
): Promise<string[]> {
  const dir = artifactDir(cohortId, entityType, entityId);
  try {
    return await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export function getArtifactPath(
  cohortId: string,
  entityType: EntityType,
  entityId: string,
  filename: string,
): string {
  return path.join(artifactDir(cohortId, entityType, entityId), filename);
}
