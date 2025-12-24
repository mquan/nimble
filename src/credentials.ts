import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

const ENCRYPTION_KEY_ENV = "MINI_MCP_ENCRYPTION_KEY";
const KEY_LENGTH = 32;
const SCRYPT_SALT_BYTES = 16;
const IV_BYTES = 12;

type StoredCredential = {
  ref: string;
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  updated_at: number;
};

export type CredentialStoreOptions = {
  manifestPath: string;
};

export class CredentialStore {
  private db: Database.Database;
  private key: Buffer;

  constructor(options: CredentialStoreOptions) {
    const manifestDir = path.dirname(options.manifestPath);
    const dbPath = path.join(manifestDir, "credentials.sqlite");
    fs.mkdirSync(manifestDir, { recursive: true });
    this.db = new Database(dbPath);
    this.ensureSchema();
    this.key = this.deriveKey();
  }

  get(ref: string): string | null {
    const row = this.db
      .prepare(
        "SELECT ref, ciphertext, iv, tag, updated_at FROM credentials WHERE ref = ?",
      )
      .get(ref) as StoredCredential | undefined;
    if (!row) {
      return null;
    }
    return this.decrypt(row.ciphertext, row.iv, row.tag);
  }

  set(ref: string, value: string): void {
    const { ciphertext, iv, tag } = this.encrypt(value);
    const updatedAt = Date.now();
    this.db
      .prepare(
        "INSERT INTO credentials (ref, ciphertext, iv, tag, updated_at)\n" +
          "VALUES (?, ?, ?, ?, ?)\n" +
          "ON CONFLICT(ref) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag, updated_at = excluded.updated_at",
      )
      .run(ref, ciphertext, iv, tag, updatedAt);
  }

  remove(ref: string): void {
    this.db.prepare("DELETE FROM credentials WHERE ref = ?").run(ref);
  }

  private ensureSchema(): void {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value BLOB NOT NULL);\n" +
        "CREATE TABLE IF NOT EXISTS credentials (\n" +
        "  ref TEXT PRIMARY KEY,\n" +
        "  ciphertext BLOB NOT NULL,\n" +
        "  iv BLOB NOT NULL,\n" +
        "  tag BLOB NOT NULL,\n" +
        "  updated_at INTEGER NOT NULL\n" +
        ");",
    );
  }

  private deriveKey(): Buffer {
    const encryptionKey = process.env[ENCRYPTION_KEY_ENV];
    if (!encryptionKey) {
      throw new Error(`${ENCRYPTION_KEY_ENV} is required`);
    }
    const salt = this.getOrCreateSalt();
    return crypto.scryptSync(encryptionKey, salt, KEY_LENGTH);
  }

  private getOrCreateSalt(): Buffer {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get("salt") as { value: Buffer } | undefined;
    if (row?.value) {
      return row.value;
    }
    const salt = crypto.randomBytes(SCRYPT_SALT_BYTES);
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?)")
      .run("salt", salt);
    return salt;
  }

  private encrypt(plaintext: string): {
    ciphertext: Buffer;
    iv: Buffer;
    tag: Buffer;
  } {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return { ciphertext, iv, tag };
  }

  private decrypt(ciphertext: Buffer, iv: Buffer, tag: Buffer): string {
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  }
}
