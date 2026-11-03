import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openLocalStorage } from '../lib/local-storage.mjs';
import { localRequestAllowed } from '../lib/local-security.mjs';
import { acquireDataLock } from '../scripts/data-lock.mjs';
import { backupData, restoreData, verifyBackup } from '../scripts/data-backup.mjs';

function temporary(t) { const directory = mkdtempSync(path.join(tmpdir(), 'strategy-lab-test-')); t.localClosers=[]; t.after(()=>{for(const close of t.localClosers)close();const target=path.resolve(directory);assert.ok(target.startsWith(path.resolve(tmpdir())+path.sep)&&path.basename(target).startsWith('strategy-lab-test-'));rmSync(target,{recursive:true,force:true});}); return directory; }

test('empty SQLite initializes once and persists records/settings after process restart', async t => {
  const directory = path.join(temporary(t),'data');
  let storage = openLocalStorage(directory);
  assert.equal((await storage.db.prepare('SELECT * FROM trade_records').all()).results.length,0);
  const count = storage.sql.prepare('SELECT COUNT(*) AS n FROM local_migrations').get().n;
  assert.equal(count,5);
  await storage.db.prepare('INSERT INTO user_settings(owner_id,data,updated_at) VALUES(?,?,?)').bind('local-owner','{"capital":10000}','2030-01-01').run();
  storage.close();
  const script = "import {openLocalStorage} from './lib/local-storage.mjs';const s=openLocalStorage(process.argv[1]);console.log(s.sql.prepare('SELECT data FROM user_settings').get().data);s.close();";
  const child = spawnSync(process.execPath,['--input-type=module','-e',script,directory],{cwd:process.cwd(),encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);
  assert.deepEqual(JSON.parse(child.stdout.trim()),{capital:10000});
  storage = openLocalStorage(directory);
  assert.equal(storage.sql.prepare('SELECT COUNT(*) AS n FROM local_migrations').get().n,count);
  storage.close();
});

test('real adapter supports INSERT RETURNING, atomic batch rollback, edits and deletions', async t => {
  const storage = openLocalStorage(path.join(temporary(t),'data')); t.localClosers.push(()=>storage.close());
  const {db} = storage;
  let results = await db.batch([
    db.prepare('INSERT INTO daily_records VALUES(?,?,?,?) RETURNING date').bind('local-owner','2030-01-01','{"note":"Demo"}','now'),
    db.prepare('SELECT data FROM daily_records WHERE owner_id=?').bind('local-owner'),
  ]);
  assert.equal(results[0].results[0].date,'2030-01-01');
  assert.deepEqual(JSON.parse(results[1].results[0].data),{note:'Demo'});
  await assert.rejects(db.batch([
    db.prepare('UPDATE daily_records SET data=?').bind('invalid'),
    db.prepare('INSERT INTO daily_records VALUES(?,?,?,?)').bind('local-owner','2030-01-01','duplicate','now'),
  ]));
  assert.equal((await db.prepare('SELECT data FROM daily_records').first()).data,'{"note":"Demo"}');
  await db.prepare('UPDATE daily_records SET data=? WHERE date=?').bind('{"note":"Demo edited"}','2030-01-01').run();
  assert.equal((await db.prepare('SELECT data FROM daily_records').first('data')),'{"note":"Demo edited"}');
  await db.prepare('DELETE FROM daily_records WHERE date=?').bind('2030-01-01').run();
  assert.equal((await db.prepare('SELECT * FROM daily_records').first()),null);
});

test('local attachments persist and reject traversal paths',async t=>{
  const directory=path.join(temporary(t),'data');let storage=openLocalStorage(directory);
  const bytes=new Uint8Array([1,2,3]);await storage.bucket.put('screenshots/local-owner/demo.png',bytes.buffer);storage.close();
  storage=openLocalStorage(directory);t.localClosers.push(()=>storage.close());
  assert.deepEqual((await storage.bucket.get('screenshots/local-owner/demo.png')).body,bytes);
  for(const key of ['../secret','/absolute','screenshots/../../secret','screenshots\\secret','screenshots//bad'])await assert.rejects(storage.bucket.put(key,bytes.buffer));
  await storage.bucket.delete('screenshots/local-owner/demo.png');assert.equal(await storage.bucket.get('screenshots/local-owner/demo.png'),null);
});

test('full backup restores database and attachments and preserves replaced data',async t=>{
  const root=temporary(t),source=path.join(root,'source'),destination=path.join(root,'restored'),backup=path.join(root,'backup');
  let s=openLocalStorage(source);await s.db.prepare('INSERT INTO daily_drafts VALUES(?,?,?,?)').bind('local-owner','2030-01-02','{"Demo":true}','now').run();await s.bucket.put('screenshots/demo.png',new Uint8Array([5,6]).buffer);s.close();
  backupData(source,backup);assert.equal(verifyBackup(backup).version,1);restoreData(backup,destination);
  s=openLocalStorage(destination);assert.equal((await s.db.prepare('SELECT data FROM daily_drafts').first()).data,'{"Demo":true}');assert.deepEqual((await s.bucket.get('screenshots/demo.png')).body,new Uint8Array([5,6]));s.close();
  assert.throws(()=>restoreData(backup,destination),/非空/);
  const replaced=restoreData(backup,destination,true);assert.ok(existsSync(path.join(replaced.previous,'journal.sqlite')));
});

test('backup/restore refuse active application locks and tampered backups', t=>{
  const root=temporary(t),source=path.join(root,'data'),backup=path.join(root,'backup');openLocalStorage(source).close();
  const lock=acquireDataLock(source);assert.throws(()=>backupData(source,backup),/正在使用/);lock.release();
  backupData(source,backup);writeFileSync(path.join(backup,'journal.sqlite'),'tampered');assert.throws(()=>restoreData(backup,path.join(root,'restore')),/校验失败/);
  assert.ok(!existsSync(path.join(root,'restore')));
});

test('loopback guard rejects DNS rebinding, cross-origin reads/writes and forwarded hosts',()=>{
  const req=(url='http://127.0.0.1:3000/api/records',headers={})=>new Request(url,{headers});
  assert.equal(localRequestAllowed(req()),true);
  assert.equal(localRequestAllowed(req('http://localhost:3000/',{host:'localhost:3000',origin:'http://localhost:3000'})),true);
  assert.equal(localRequestAllowed(req('http://evil.example:3000/api/records')),false);
  for(const headers of [{host:'evil.example:3000'},{origin:'http://evil.example:3000'},{origin:'null'},{'sec-fetch-site':'cross-site'},{'x-forwarded-host':'evil.example:3000'}])assert.equal(localRequestAllowed(req(undefined,headers)),false);
});
