import { DEMO_SETTINGS } from './demo-settings.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as domain from '../lib/domain.ts';
import * as repository from '../lib/repository.ts';

import { apiHarness as harness } from './api-harness.mjs';

test('draft and record APIs reject missing identity and cross-origin writes before changing data',async()=>{
  const h=harness(),d=domain.blankDay('2026-10-10');h.setUser(null);
  assert.equal((await h.drafts.GET(h.req('/api/drafts?date='+d.date))).status,401);assert.equal((await h.records.GET()).status,401);
  h.setUser({userId:'A'});assert.equal((await h.drafts.PUT(h.req('/api/drafts','PUT',d,'https://other.test'))).status,403);
  assert.equal((await h.records.PUT(h.req('/api/records','PUT',d,'https://other.test'))).status,403);assert.equal((await repository.loadData(h.db,'A')).records.length,0);assert.equal((await repository.loadDrafts(h.db,'A')).length,0);h.sql.close();
});
test('draft reload returns latest personal values and formal API keeps drafts out of confirmed statistics',async()=>{
  const h=harness(),d={...domain.blankDay('2026-10-11'),wellbeing:{stress:0,worry:8,energy:2,sleepHours:4.25,exercised:false,trigger:'工作压力，\n长中文'.repeat(100)},note:'尚未确认'};
  assert.equal((await h.drafts.PUT(h.req('/api/drafts','PUT',d))).status,200);
  let result=await (await h.records.GET()).json();assert.equal(result.records.length,0);assert.deepEqual(result.drafts[0].record,d);
  assert.deepEqual((await (await h.drafts.GET(h.req('/api/drafts?date='+d.date))).json()).draft.record,d);
  h.setUser({userId:'B'});assert.equal((await (await h.drafts.GET(h.req('/api/drafts?date='+d.date))).json()).draft,null);assert.equal((await (await h.records.GET()).json()).drafts.length,0);
  h.setUser({userId:'A'});assert.equal((await h.records.PUT(h.req('/api/records','PUT',d))).status,200);result=await (await h.records.GET()).json();assert.deepEqual(result.records,[d]);assert.equal(result.drafts.length,0);h.sql.close();
});
test('confirmation validates current saved risk limit, context coverage and legacy record compatibility',async()=>{
  const h=harness(),d=domain.blankDay('2026-10-10');await repository.saveSettings(h.db,'A',{...DEMO_SETTINGS,riskLimit:400});
  assert.equal((await h.records.PUT(h.req('/api/records','PUT',d))).status,200);assert.deepEqual((await (await h.records.GET()).json()).records[0],d);
  const risky={...d,trades:[{id:'t',model:'S1',netPnl:10,initialRisk:450,inPlan:true}]};assert.equal((await h.records.PUT(h.req('/api/records','PUT',risky))).status,400);
  assert.equal((await h.drafts.PUT(h.req('/api/drafts','PUT',{...d,wellbeing:{energy:11}}))).status,400);
  assert.equal((await h.records.PUT(h.req('/api/records','PUT',{...d,wellbeing:{violationContexts:[{time:'10:30',fatigued:true}]}}))).status,400);
  assert.deepEqual((await (await h.records.GET()).json()).records[0],d);h.sql.close();
});
