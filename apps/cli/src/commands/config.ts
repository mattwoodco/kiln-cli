import { Args, Command, Flags } from "@oclif/core";
import { ConfigStore, type KilnConfig } from "../lib/config-store.js";
import { KilnError, formatKilnError, isKilnError } from "../lib/errors.js";

type ConfigKey = "anthropic-key" | "openai-key" | "google-key" | "auth-token" | "cohort";

const VALID_KEYS: readonly ConfigKey[] = [
  "anthropic-key",
  "openai-key",
  "google-key",
  "auth-token",
  "cohort",
] as const;

function isConfigKey(s: string): s is ConfigKey {
  return (VALID_KEYS as readonly string[]).includes(s);
}

function readKey(cfg: KilnConfig, key: ConfigKey): string | undefined {
  switch (key) {
    case "anthropic-key":
      return cfg.anthropicKey;
    case "openai-key":
      return cfg.openaiKey;
    case "google-key":
      return cfg.googleKey;
    case "auth-token":
      return cfg.authToken;
    case "cohort":
      return cfg.cohortName;
  }
}

function writeKey(cfg: KilnConfig, key: ConfigKey, value: string): KilnConfig {
  switch (key) {
    case "anthropic-key":
      return { ...cfg, anthropicKey: value };
    case "openai-key":
      return { ...cfg, openaiKey: value };
    case "google-key":
      return { ...cfg, googleKey: value };
    case "auth-token":
      return { ...cfg, authToken: value };
    case "cohort":
      return { ...cfg, cohortName: value };
  }
}

function mask(value: string | undefined): string {
  if (!value) return "(unset)";
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export default class Config extends Command {
  static override description =
    "Read or update values in ~/.kiln/config.json. Usage: kiln config <set|get|list> [key] [value].";

  static override examples = [
    "$ kiln config list",
    "$ kiln config get cohort",
    "$ kiln config set anthropic-key sk-ant-...",
  ];

  static override strict = false;

  static override args = {
    action: Args.string({
      description: "set | get | list",
      required: true,
      options: ["set", "get", "list"],
    }),
    key: Args.string({ description: "config key" }),
    value: Args.string({ description: "value (for set)" }),
  };

  static override flags = {
    ci: Flags.boolean({ description: "Non-interactive mode." }),
    verbose: Flags.boolean({ description: "Show full secret values (otherwise masked)." }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Config);
    const verbose = flags.verbose === true;
    const store = new ConfigStore();

    try {
      if (args.action === "list") {
        if (!(await store.exists())) {
          this.log("(no config — run 'kiln init')");
          return;
        }
        const cfg = await store.read();
        for (const k of VALID_KEYS) {
          const raw = readKey(cfg, k);
          this.log(`${k}=${verbose ? (raw ?? "(unset)") : mask(raw)}`);
        }
        this.log(`cohort-id=${cfg.cohortId ?? "(unset)"}`);
        this.log(`current-week=${cfg.currentWeek ?? "(unset)"}`);
        this.log(`container-runtime=${cfg.containerRuntime ?? "(unset)"}`);
        this.log(`api-url=${cfg.apiUrl ?? "(unset)"}`);
        return;
      }

      if (args.action === "get") {
        if (!args.key) {
          throw new KilnError("`kiln config get` requires a key argument.", {
            fix: `Use one of: ${VALID_KEYS.join(", ")}.`,
            code: "CONFIG_GET_NOKEY",
          });
        }
        if (!isConfigKey(args.key)) {
          throw new KilnError(`Unknown config key: ${args.key}`, {
            fix: `Valid keys: ${VALID_KEYS.join(", ")}.`,
            code: "CONFIG_BAD_KEY",
          });
        }
        const cfg = await store.read();
        const raw = readKey(cfg, args.key);
        this.log(verbose ? (raw ?? "(unset)") : mask(raw));
        return;
      }

      if (args.action === "set") {
        if (!args.key || args.value === undefined) {
          throw new KilnError("`kiln config set` requires <key> and <value>.", {
            fix: "Example: kiln config set anthropic-key sk-ant-...",
            code: "CONFIG_SET_ARGS",
          });
        }
        if (!isConfigKey(args.key)) {
          throw new KilnError(`Unknown config key: ${args.key}`, {
            fix: `Valid keys: ${VALID_KEYS.join(", ")}.`,
            code: "CONFIG_BAD_KEY",
          });
        }
        const current = (await store.exists()) ? await store.read() : { version: "v1" };
        const next = writeKey(current, args.key, args.value);
        await store.write(next);
        this.log(`set ${args.key}`);
        return;
      }
    } catch (err) {
      if (isKilnError(err)) {
        this.log(formatKilnError(err));
        this.exit(1);
      }
      throw err;
    }
  }
}
