import { Command } from "@oclif/core";

/**
 * Placeholder command so oclif has at least one command to discover during
 * Phase 1. Real commands (init, doctor, harness, grade, ...) land in Phase 2+.
 */
export default class Hello extends Command {
  static override description = "Placeholder command; real commands land in Phase 2.";

  async run(): Promise<void> {
    this.log("kiln cli scaffold ready");
  }
}
