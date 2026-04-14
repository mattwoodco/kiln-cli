import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir, hostname, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { KilnError } from "./errors.js";

const KEY_LENGTH = 32; // AES-256
const IV_LENGTH = 12; // GCM recommended IV size
const SALT_LENGTH = 16;
const TAG_LENGTH = 16;
const PBKDF2_ITERATIONS = 100_000;

export interface KilnConfig {
  // Encrypted secrets
  anthropicKey?: string;
  openaiKey?: string;
  googleKey?: string;
  authToken?: string;
  // Clear metadata
  cohortId?: string;
  cohortName?: string;
  currentWeek?: number;
  containerRuntime?: string;
  apiUrl?: string;
  version: string;
}

interface OnDiskBlob {
  version: string;
  salt: string; // base64
  iv: string; // base64
  tag: string; // base64
  ciphertext: string; // base64
  meta: {
    cohortId?: string;
    cohortName?: string;
    currentWeek?: number;
    containerRuntime?: string;
    apiUrl?: string;
  };
}

interface SecretPayload {
  anthropicKey?: string;
  openaiKey?: string;
  googleKey?: string;
  authToken?: string;
}

const CONFIG_VERSION = "v1";

function getDefaultConfigPath(): string {
  return join(homedir(), ".kiln", "config.json");
}

function deriveKey(salt: Buffer): Buffer {
  const passphrase = `${hostname()}:${userInfo().username}:kiln-${CONFIG_VERSION}`;
  return pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, KEY_LENGTH, "sha256");
}

function encryptPayload(payload: SecretPayload): {
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
} {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveKey(salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptPayload(blob: OnDiskBlob): SecretPayload {
  const salt = Buffer.from(blob.salt, "base64");
  const iv = Buffer.from(blob.iv, "base64");
  const tag = Buffer.from(blob.tag, "base64");
  const ciphertext = Buffer.from(blob.ciphertext, "base64");
  if (tag.length !== TAG_LENGTH) {
    throw new KilnError("Corrupt Kiln config: bad auth tag length.", {
      fix: "Run `kiln init --reset` to recreate the config file.",
      code: "CONFIG_CORRUPT",
    });
  }
  const key = deriveKey(salt);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8")) as SecretPayload;
  } catch (cause) {
    throw new KilnError("Failed to decrypt Kiln credentials. Host identity may have changed.", {
      fix: "Run `kiln init --reset` to re-enter credentials on this machine.",
      code: "CONFIG_DECRYPT",
      cause,
    });
  }
}

export class ConfigStore {
  public readonly path: string;

  constructor(path?: string) {
    this.path = path ?? getDefaultConfigPath();
  }

  async exists(): Promise<boolean> {
    return existsSync(this.path);
  }

  async read(): Promise<KilnConfig> {
    if (!existsSync(this.path)) {
      return { version: CONFIG_VERSION };
    }
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (cause) {
      throw new KilnError(`Unable to read ${this.path}`, {
        fix: "Check file permissions, or run `kiln init --reset`.",
        code: "CONFIG_READ",
        cause,
      });
    }
    let blob: OnDiskBlob;
    try {
      blob = JSON.parse(raw) as OnDiskBlob;
    } catch (cause) {
      throw new KilnError("Kiln config is not valid JSON.", {
        fix: "Run `kiln init --reset` to regenerate the config.",
        code: "CONFIG_PARSE",
        cause,
      });
    }
    const secrets = decryptPayload(blob);
    return {
      version: blob.version,
      anthropicKey: secrets.anthropicKey,
      openaiKey: secrets.openaiKey,
      googleKey: secrets.googleKey,
      authToken: secrets.authToken,
      cohortId: blob.meta.cohortId,
      cohortName: blob.meta.cohortName,
      currentWeek: blob.meta.currentWeek,
      containerRuntime: blob.meta.containerRuntime,
      apiUrl: blob.meta.apiUrl,
    };
  }

  async write(config: KilnConfig): Promise<void> {
    const dir = dirname(this.path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const secrets: SecretPayload = {
      anthropicKey: config.anthropicKey,
      openaiKey: config.openaiKey,
      googleKey: config.googleKey,
      authToken: config.authToken,
    };
    const encrypted = encryptPayload(secrets);
    const blob: OnDiskBlob = {
      version: CONFIG_VERSION,
      salt: encrypted.salt,
      iv: encrypted.iv,
      tag: encrypted.tag,
      ciphertext: encrypted.ciphertext,
      meta: {
        cohortId: config.cohortId,
        cohortName: config.cohortName,
        currentWeek: config.currentWeek,
        containerRuntime: config.containerRuntime,
        apiUrl: config.apiUrl,
      },
    };
    try {
      await writeFile(this.path, `${JSON.stringify(blob, null, 2)}\n`, {
        mode: 0o600,
      });
    } catch (cause) {
      throw new KilnError(`Unable to write ${this.path}`, {
        fix: "Check write permissions on your home directory, or run with --ci and --token.",
        code: "CONFIG_WRITE",
        cause,
      });
    }
  }

  async update(patch: Partial<KilnConfig>): Promise<KilnConfig> {
    const current = await this.read();
    const merged: KilnConfig = { ...current, ...patch, version: CONFIG_VERSION };
    await this.write(merged);
    return merged;
  }
}

export function defaultConfigPath(): string {
  return getDefaultConfigPath();
}
