import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftWriter } from '../lib/draft-writer.ts';

test('continuous keystrokes debounce to the latest snapshot; explicit flush includes the last character',async(t)=>{
  t.mock.timers.enable({apis:['setTimeout']});const writes=[],statuses=[];
  const writer=createDraftWriter(async d=>writes.push(d),s=>statuses.push(s));
  for(const note of ['中','中文','中文连续','中文连续输入']){writer.enqueue({note});t.mock.timers.tick(400);assert.equal(writes.length,0);}
  await writer.flush();assert.deepEqual(writes,[{note:'中文连续输入'}]);assert.equal(statuses.filter(s=>s==='editing').length,1);writer.close();
});
test('writes serialize and flush waits for an in-flight save plus newer edits',async()=>{
  let resolve;const gate=new Promise(r=>resolve=r);const writes=[];let active=0,maximum=0;
  const writer=createDraftWriter(async d=>{active++;maximum=Math.max(maximum,active);writes.push(d);if(d.n===1)await gate;active--;},()=>{});
  writer.enqueue({n:1});const first=writer.flush();writer.enqueue({n:2});const second=writer.flush();resolve();await Promise.all([first,second]);assert.equal(maximum,1);assert.deepEqual(writes,[{n:1},{n:2}]);writer.close();
});
test('failed writes retain the latest unsaved edit and allow retry; closing cancels queued timers',async(t)=>{
  t.mock.timers.enable({apis:['setTimeout']});let fail=true;const writes=[],statuses=[];
  const writer=createDraftWriter(async d=>{if(fail)throw new Error('离线');writes.push(d);},(s,e)=>statuses.push([s,e]));
  writer.enqueue({note:'长文字'});await assert.rejects(writer.flush(),/离线/);assert.equal(writer.hasPending(),true);assert.equal(statuses.at(-1)[0],'error');
  writer.enqueue({note:'最新文字'});fail=false;await writer.flush();assert.deepEqual(writes,[{note:'最新文字'}]);assert.equal(writer.hasPending(),false);
  writer.enqueue({note:'取消定时'});writer.close();t.mock.timers.tick(2000);assert.equal(writes.length,1);
});
