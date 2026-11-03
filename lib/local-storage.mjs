import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export function dataDirectory() { return path.resolve(process.cwd(), process.env.DATA_DIR || './data'); }
export function loadEnvironment() {
  const file = path.resolve('.env');
  if (existsSync(file)) process.loadEnvFile(file);
}
function privateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) throw new Error('数据目录不能是符号链接。');
}
export function openLocalStorage(directory = dataDirectory()) {
  privateDirectory(directory);
  const databaseFile = path.join(directory, 'journal.sqlite');
  if (existsSync(databaseFile) && lstatSync(databaseFile).isSymbolicLink()) throw new Error('数据库不能是符号链接。');
  const sql = new DatabaseSync(databaseFile);
  sql.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  sql.exec('CREATE TABLE IF NOT EXISTS local_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL)');
  const migrationDirectory = path.resolve(process.cwd(), 'drizzle');
  try {
    sql.exec('BEGIN IMMEDIATE');
    for (const name of readdirSync(migrationDirectory).filter(name => name.endsWith('.sql')).sort()) {
      const source = readFileSync(path.join(migrationDirectory, name), 'utf8');
      const hash = createHash('sha256').update(source).digest('hex');
      const previous = sql.prepare('SELECT sha256 FROM local_migrations WHERE name=?').get(name);
      if (previous && previous.sha256 !== hash) throw new Error('已应用的数据库迁移被修改：' + name);
      if (!previous) {
        sql.exec(source);
        sql.prepare('INSERT INTO local_migrations(name,sha256) VALUES(?,?)').run(name, hash);
      }
    }
    sql.exec('COMMIT');
  } catch (error) { sql.exec('ROLLBACK'); sql.close(); throw error; }
  const execute = Symbol('execute');
  const db = {
    prepare(query) {
      const statement = sql.prepare(query);
      let values = [];
      const prepared = {
        bind(...args) { values = args; return prepared; },
        [execute]() {
          const results = statement.all(...values);
          return { success: true, results, meta: { changes: Number(sql.prepare('SELECT changes() AS n').get().n) } };
        },
        async first(column) { const row = statement.get(...values); return row ? column ? row[column] : row : null; },
        async all() { return prepared[execute](); },
        async run() { return prepared[execute](); },
      };
      return prepared;
    },
    async batch(statements) {
      // Execute synchronously until COMMIT; no awaited operation can interleave.
      sql.exec('BEGIN IMMEDIATE');
      try { const result = statements.map(statement => statement[execute]()); sql.exec('COMMIT'); return result; }
      catch (error) { sql.exec('ROLLBACK'); throw error; }
    },
  };
  const attachmentRoot = path.join(directory, 'attachments');
  privateDirectory(attachmentRoot);
  function objectPath(key, create = false) {
    if (typeof key !== 'string' || !key || key.includes('\\') || key.includes('\0') || key.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('附件路径无效。');
    const destination = path.resolve(attachmentRoot, ...key.split('/'));
    if (!destination.startsWith(attachmentRoot + path.sep)) throw new Error('附件路径超出存储目录。');
    let current = attachmentRoot;
    const pieces = key.split('/');
    for (let i = 0; i < pieces.length; i++) {
      current = path.join(current, pieces[i]);
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('附件路径不能包含符号链接。');
      if (create && i < pieces.length - 1) privateDirectory(current);
    }
    return destination;
  }
  const bucket = {
    async put(key, bytes) {
      const destination = objectPath(key, true), temporary = destination + '.tmp-' + randomUUID();
      try { writeFileSync(temporary, new Uint8Array(bytes), { mode: 0o600, flag: 'wx' }); renameSync(temporary, destination); }
      finally { rmSync(temporary, { force: true }); }
    },
    async get(key) {
      const file = objectPath(key);
      try { return { body: new Uint8Array(readFileSync(file)) }; }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    async delete(key) { rmSync(objectPath(key), { force: true }); },
  };
  return { db, bucket, sql, directory, close() { sql.exec('PRAGMA wal_checkpoint(TRUNCATE)'); sql.close(); } };
}
const singleton = Symbol.for('gold-strategy-lab.local-storage');
export function getLocalStorage() { return globalThis[singleton] ??= openLocalStorage(); }
