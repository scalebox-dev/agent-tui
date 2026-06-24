export interface AppEngineStorage {
  read<T = Record<string, unknown>>(name: string, fallback?: T): Promise<T>;
  write(name: string, value: unknown): Promise<void | string>;
  get<T = unknown>(name: string, key: string, fallback?: T): Promise<T>;
  set(name: string, key: string, value: unknown): Promise<void | string>;
  delete(name: string, key: string): Promise<void | string>;
}

export interface FileConfigStoreLike {
  read<T = Record<string, unknown>>(name: string, fallback?: T): Promise<T>;
  write(name: string, value: unknown): Promise<void | string>;
  get<T = unknown>(name: string, key: string, fallback?: T): Promise<T>;
  set(name: string, key: string, value: unknown): Promise<void | string>;
  delete(name: string, key: string): Promise<void | string>;
}

export interface MemoryStorageOptions {
  seed?: Record<string, unknown>;
}

export function createMemoryStorage(options: MemoryStorageOptions = {}): AppEngineStorage {
  const documents = new Map<string, unknown>(Object.entries(options.seed ?? {}).map(([key, value]) => [key, cloneJSON(value)]));
  return {
    async read<T = Record<string, unknown>>(name: string, fallback?: T): Promise<T> {
      if (!documents.has(name)) return cloneJSON(fallback) as T;
      return cloneJSON(documents.get(name)) as T;
    },
    async write(name: string, value: unknown): Promise<void> {
      documents.set(name, cloneJSON(value));
    },
    async get<T = unknown>(name: string, key: string, fallback?: T): Promise<T> {
      const record = recordFrom(await this.read<unknown>(name, {}), name);
      return (key in record ? cloneJSON(record[key]) : cloneJSON(fallback)) as T;
    },
    async set(name: string, key: string, value: unknown): Promise<void> {
      const record = recordFrom(await this.read<unknown>(name, {}), name);
      record[key] = cloneJSON(value);
      await this.write(name, record);
    },
    async delete(name: string, key: string): Promise<void> {
      const record = recordFrom(await this.read<unknown>(name, {}), name);
      delete record[key];
      await this.write(name, record);
    },
  };
}

export function createFileStorage(config: FileConfigStoreLike): AppEngineStorage {
  return {
    read: config.read.bind(config),
    write: config.write.bind(config),
    get: config.get.bind(config),
    set: config.set.bind(config),
    delete: config.delete.bind(config),
  };
}

export type SQLStorageDialect = "postgres" | "mysql" | "sqlite";

export interface SQLQueryResult {
  rows?: unknown[];
  [key: string]: unknown;
}

export interface SQLExecutor {
  query?(sql: string, params?: unknown[]): Promise<SQLQueryResult | unknown[] | [unknown[], unknown]>;
  execute?(sql: string, params?: unknown[]): Promise<SQLQueryResult | unknown[] | [unknown[], unknown]>;
  run?(sql: string, params?: unknown[]): Promise<unknown>;
  get?(sql: string, params?: unknown[]): Promise<unknown>;
  all?(sql: string, params?: unknown[]): Promise<unknown[]>;
  prepare?(sql: string): {
    run?(...params: unknown[]): unknown;
    get?(...params: unknown[]): unknown;
    all?(...params: unknown[]): unknown[];
  };
}

export interface SQLStorageOptions {
  dialect: SQLStorageDialect;
  executor: SQLExecutor;
  tableName?: string;
  autoInitialize?: boolean;
}

export function createSQLStorage(options: SQLStorageOptions): AppEngineStorage {
  const table = quoteIdentifier(options.tableName ?? "agent_app_documents");
  const dialect = options.dialect;
  const executor = options.executor;
  let initialized = false;

  async function ensureInitialized() {
    if (initialized || options.autoInitialize === false) return;
    const timestampColumn = dialect === "mysql"
      ? "updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"
      : "updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP";
    await runSQL(executor, `CREATE TABLE IF NOT EXISTS ${table} (name VARCHAR(255) PRIMARY KEY, value TEXT NOT NULL, ${timestampColumn})`);
    initialized = true;
  }

  async function readRaw(name: string): Promise<unknown | undefined> {
    await ensureInitialized();
    const rows = await selectSQL(executor, `SELECT value FROM ${table} WHERE name = ${param(1, dialect)} LIMIT 1`, [name]);
    const row = rows[0] as { value?: unknown } | undefined;
    if (!row) return undefined;
    const value = typeof row.value === "string" || Buffer.isBuffer(row.value)
      ? row.value.toString()
      : String(row.value ?? "");
    return value ? JSON.parse(value) : undefined;
  }

  async function writeRaw(name: string, value: unknown) {
    await ensureInitialized();
    const payload = JSON.stringify(value);
    if (dialect === "postgres") {
      await runSQL(executor, `INSERT INTO ${table} (name, value) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`, [name, payload]);
      return;
    }
    if (dialect === "mysql") {
      await runSQL(executor, `INSERT INTO ${table} (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)`, [name, payload]);
      return;
    }
    await runSQL(executor, `INSERT INTO ${table} (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`, [name, payload]);
  }

  return documentStorageFromRaw({ readRaw, writeRaw });
}

export function createPostgresStorage(client: SQLExecutor, options: Omit<SQLStorageOptions, "dialect" | "executor"> = {}) {
  return createSQLStorage({ ...options, dialect: "postgres", executor: client });
}

export function createMySQLStorage(client: SQLExecutor, options: Omit<SQLStorageOptions, "dialect" | "executor"> = {}) {
  return createSQLStorage({ ...options, dialect: "mysql", executor: client });
}

export function createSQLiteStorage(database: SQLExecutor, options: Omit<SQLStorageOptions, "dialect" | "executor"> = {}) {
  return createSQLStorage({ ...options, dialect: "sqlite", executor: database });
}

export interface KeyValueClient {
  get(key: string): Promise<string | null | undefined> | string | null | undefined;
  set(key: string, value: string): Promise<unknown> | unknown;
  del?(key: string): Promise<unknown> | unknown;
  delete?(key: string): Promise<unknown> | unknown;
}

export interface KeyValueStorageOptions {
  client: KeyValueClient;
  keyPrefix?: string;
}

export function createKeyValueStorage(options: KeyValueStorageOptions): AppEngineStorage {
  const prefix = options.keyPrefix ?? "agent-app-engine:";
  const client = options.client;
  return documentStorageFromRaw({
    async readRaw(name) {
      const value = await client.get(`${prefix}${name}`);
      return value ? JSON.parse(value) : undefined;
    },
    async writeRaw(name, value) {
      await client.set(`${prefix}${name}`, JSON.stringify(value));
    },
    async deleteRaw(name) {
      if (client.del) await client.del(`${prefix}${name}`);
      else if (client.delete) await client.delete(`${prefix}${name}`);
    },
  });
}

export function createRedisStorage(client: KeyValueClient, options: Omit<KeyValueStorageOptions, "client"> = {}) {
  return createKeyValueStorage({ ...options, client });
}

export interface KeychainClient {
  getPassword(service: string, account: string): Promise<string | null> | string | null;
  setPassword(service: string, account: string, password: string): Promise<unknown> | unknown;
  deletePassword(service: string, account: string): Promise<boolean> | boolean;
}

export interface KeychainStorageOptions {
  keychain: KeychainClient;
  service?: string;
  accountPrefix?: string;
}

export function createKeychainStorage(options: KeychainStorageOptions): AppEngineStorage {
  const service = options.service ?? "agent-api-app-engine";
  const prefix = options.accountPrefix ?? "document:";
  const keychain = options.keychain;
  return documentStorageFromRaw({
    async readRaw(name) {
      const value = await keychain.getPassword(service, `${prefix}${name}`);
      return value ? JSON.parse(value) : undefined;
    },
    async writeRaw(name, value) {
      await keychain.setPassword(service, `${prefix}${name}`, JSON.stringify(value));
    },
    async deleteRaw(name) {
      await keychain.deletePassword(service, `${prefix}${name}`);
    },
  });
}

function documentStorageFromRaw(raw: {
  readRaw(name: string): Promise<unknown | undefined>;
  writeRaw(name: string, value: unknown): Promise<void>;
  deleteRaw?(name: string): Promise<void>;
}): AppEngineStorage {
  return {
    async read<T = Record<string, unknown>>(name: string, fallback?: T): Promise<T> {
      const value = await raw.readRaw(name);
      return (value === undefined ? cloneJSON(fallback) : cloneJSON(value)) as T;
    },
    async write(name: string, value: unknown): Promise<void> {
      await raw.writeRaw(name, cloneJSON(value));
    },
    async get<T = unknown>(name: string, key: string, fallback?: T): Promise<T> {
      const record = recordFrom(await this.read<unknown>(name, {}), name);
      return (key in record ? cloneJSON(record[key]) : cloneJSON(fallback)) as T;
    },
    async set(name: string, key: string, value: unknown): Promise<void> {
      const record = recordFrom(await this.read<unknown>(name, {}), name);
      record[key] = cloneJSON(value);
      await this.write(name, record);
    },
    async delete(name: string, key: string): Promise<void> {
      const record = recordFrom(await this.read<unknown>(name, {}), name);
      delete record[key];
      if (Object.keys(record).length === 0 && raw.deleteRaw) {
        await raw.deleteRaw(name);
      } else {
        await this.write(name, record);
      }
    },
  };
}

async function runSQL(executor: SQLExecutor, sql: string, params: unknown[] = []) {
  if (executor.execute) return await executor.execute(sql, params);
  if (executor.query) return await executor.query(sql, params);
  if (executor.run) return await executor.run(sql, params);
  if (executor.prepare) return executor.prepare(sql).run?.(...params);
  throw new Error("SQL executor must provide execute(), query(), run(), or prepare().run()");
}

async function selectSQL(executor: SQLExecutor, sql: string, params: unknown[] = []): Promise<unknown[]> {
  if (executor.query) return normalizeRows(await executor.query(sql, params));
  if (executor.execute) return normalizeRows(await executor.execute(sql, params));
  if (executor.all) return await executor.all(sql, params);
  if (executor.get) {
    const row = await executor.get(sql, params);
    return row ? [row] : [];
  }
  if (executor.prepare) {
    const statement = executor.prepare(sql);
    if (statement.all) return statement.all(...params);
    const row = statement.get?.(...params);
    return row ? [row] : [];
  }
  throw new Error("SQL executor must provide query(), execute(), all(), get(), or prepare().");
}

function normalizeRows(result: SQLQueryResult | unknown[] | [unknown[], unknown]): unknown[] {
  if (Array.isArray(result)) {
    if (Array.isArray(result[0])) return result[0] as unknown[];
    return result;
  }
  return Array.isArray(result.rows) ? result.rows : [];
}

function param(index: number, dialect: SQLStorageDialect) {
  return dialect === "postgres" ? `$${index}` : "?";
}

function quoteIdentifier(identifier: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid SQL identifier: ${identifier}`);
  }
  return identifier;
}

function recordFrom(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Storage document ${name} must contain a JSON object`);
  }
  return { ...(value as Record<string, unknown>) };
}

function cloneJSON<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
