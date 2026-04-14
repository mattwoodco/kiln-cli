#!/usr/bin/env node
// Entry point for the `kiln` binary. Real command logic lives in dist/commands.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { run } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");

run(process.argv.slice(2), packageRoot).catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
