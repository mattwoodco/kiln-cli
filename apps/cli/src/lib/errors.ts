/**
 * KilnError — every CLI error carries a `fix` hint so users can self-recover.
 * Command catch-handlers render these through Clack.
 */
export class KilnError extends Error {
  public readonly fix: string;
  public readonly code: string;
  public override readonly cause?: unknown;

  constructor(message: string, options: { fix: string; code?: string; cause?: unknown }) {
    super(message);
    this.name = "KilnError";
    this.fix = options.fix;
    this.code = options.code ?? "KILN_ERR";
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export function isKilnError(err: unknown): err is KilnError {
  return err instanceof KilnError;
}

/**
 * Format a KilnError for display. Commands pass this into Clack's outro
 * or log.error so users see both the problem and the recovery step.
 */
export function formatKilnError(err: KilnError): string {
  return `${err.message}\n  fix: ${err.fix}`;
}
