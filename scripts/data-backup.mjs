import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openLocalStorage } from '../lib/local-storage.mjs';
import { acquireDataLock } from './data-lock.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function related(a,b) { return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep); }
function files(directory, relative = '') {
  const result = [];
  for (const name of readdirSync(path.join(directory, relative))) {
    const file = path.join(relative, name), info = lstatSync(path.join(directory, file));
    if (info.isSymbolicLink()) throw new Error('备份不允许包含符号链接。');
    if (info.isDirectory()) result.push(...files(directory, file));
    else if (info.isFile()) result.push(file.split(path.sep).join('/'));
    else throw new Error('备份含不支持的文件类型。');
  }
  return result.sort();
}
function verifyDatabase(file) {
  const sql = new DatabaseSync(file, {readOnly: true});
  try {
    if (sql.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('数据库完整性检查失败。');
    const expected = ['daily_records','user_settings','daily_drafts','trade_records','trade_images','record_history','source_backups','opportunity_records','local_migrations'];
    for (const name of expected) if (!sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)) throw new Error('备份缺少数据表：' + name);
  } finally { sql.close(); }
}
export function verifyBackup(directory) {
  if (lstatSync(directory).isSymbolicLink()) throw new Error('备份目录不能是符号链接。');
  const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.format !== 'gold-strategy-lab-backup' || manifest.version !== 1 || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) throw new Error('不支持的备份格式。');
  const actual = files(directory).filter(file => file !== 'manifest.json');
  if (JSON.stringify(actual) !== JSON.stringify(Object.keys(manifest.files).sort())) throw new Error('备份文件清单不一致。');
  for (const file of actual) {
    if (file !== 'journal.sqlite' && !file.startsWith('attachments/')) throw new Error('备份含不允许的文件。');
    if (!/^[a-f0-9]{64}$/.test(manifest.files[file]) || sha256(readFileSync(path.join(directory,file))) !== manifest.files[file]) throw new Error('备份文件校验失败：' + file);
  }
  if (!actual.includes('journal.sqlite')) throw new Error('备份缺少数据库。');
  verifyDatabase(path.join(directory, 'journal.sqlite'));
  return manifest;
}
export function backupData(source, destination) {
  source = path.resolve(source); destination = path.resolve(destination);
  if (related(source, destination)) throw new Error('备份目录必须位于数据目录之外。');
  if (existsSync(destination)) throw new Error('备份目标已经存在；请选择一个新目录。');
  const lock = acquireDataLock(source);
  try {
    if (!existsSync(path.join(source,'journal.sqlite'))) throw new Error('尚无数据库，请先运行程序。');
    openLocalStorage(source).close();
    mkdirSync(destination, {recursive: true, mode: 0o700});
    cpSync(path.join(source, 'journal.sqlite'), path.join(destination, 'journal.sqlite'), {errorOnExist: true, force: false});
    // Portable backups use a single SQLite file, so verification needs no WAL sidecars.
    const copy = new DatabaseSync(path.join(destination, 'journal.sqlite'));
    try { copy.exec('PRAGMA journal_mode=DELETE'); } finally { copy.close(); }
    if (existsSync(path.join(source, 'attachments'))) {
      // Check source links before recursive copy.
      if (lstatSync(path.join(source, 'attachments')).isSymbolicLink()) throw new Error('附件目录不能是符号链接。');
      files(path.join(source, 'attachments'));
      cpSync(path.join(source, 'attachments'), path.join(destination,'attachments'), {recursive: true, errorOnExist: true, force: false});
    } else mkdirSync(path.join(destination,'attachments'));
    const manifest = {format: 'gold-strategy-lab-backup', version: 1, createdAt: new Date().toISOString(), files: Object.fromEntries(files(destination).map(file => [file, sha256(readFileSync(path.join(destination,file)))]))};
    writeFileSync(path.join(destination,'manifest.json'), JSON.stringify(manifest,null,2), {mode: 0o600});
    verifyBackup(destination);
    return destination;
  } finally { lock.release(); }
}
export function restoreData(source, destination, replace = false) {
  source = path.resolve(source); destination = path.resolve(destination);
  if (related(source, destination)) throw new Error('备份与数据目录不能互相包含。');
  verifyBackup(source);
  const lock = acquireDataLock(destination);
  const temporary = destination + '.restore-' + randomUUID();
  let previous;
  try {
    if (existsSync(destination) && (lstatSync(destination).isSymbolicLink() || !lstatSync(destination).isDirectory())) throw new Error('数据目标必须是普通目录。');
    if (existsSync(destination) && readdirSync(destination).length && !replace) throw new Error('数据目录非空。若要恢复并保留旧目录，请添加 --replace。');
    cpSync(source, temporary, {recursive: true, errorOnExist: true, force: false});
    verifyBackup(temporary);
    rmSync(path.join(temporary, 'manifest.json'));
    if (existsSync(destination)) {
      previous = destination + '.before-restore-' + new Date().toISOString().replaceAll(':','-') + '-' + randomUUID().slice(0,8);
      renameSync(destination, previous);
    }
    try { renameSync(temporary, destination); }
    catch (error) { if (previous) renameSync(previous,destination); throw error; }
    return {directory: destination, previous};
  } finally {
    const target = path.resolve(temporary), parent = path.dirname(destination);
    if (path.dirname(target) !== parent || !path.basename(target).startsWith(path.basename(destination) + '.restore-')) throw new Error('恢复临时目录超出预期范围。');
    if (existsSync(target)) rmSync(target, {recursive: true, force: true});
    lock.release();
  }
}
