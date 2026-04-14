// Re-export oclif's runner so bin/run.js stays a one-liner.
// Individual commands live under ./commands and are discovered by oclif
// at runtime via the `oclif.commands` path in package.json.
export { run } from "@oclif/core";
