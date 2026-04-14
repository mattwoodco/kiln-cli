import { Command } from "@oclif/core";

/**
 * `kiln admin` — topic stub.
 *
 * Plan ref: Phase 7 §3 (lines 1094-1107).
 *
 * oclif treats this file as the index command for the `admin` topic.
 * Running `kiln admin` with no subcommand prints a short help message
 * pointing at the available subcommands. The real work happens in
 * `commands/admin/usage.ts` (and any future admin commands).
 */
export default class Admin extends Command {
  static override description = "Admin tools (cohort + usage analytics).";
  static override hidden = false;

  async run(): Promise<void> {
    this.log("kiln admin — admin commands");
    this.log("");
    this.log("Subcommands:");
    this.log("  kiln admin usage       Cost + usage analytics (cohorts, students, forecast)");
    this.log("");
    this.log("Run `kiln admin usage --help` for the full flag list.");
  }
}
