import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { blankTrade, lifecycleSchema } from '../lib/trading.ts';
import { blankG1, g1PlanSchema } from '../lib/g1-schema.ts';

test('oversized trading collections fail before collecting per-element errors',()=>{
  for(const [field,limit] of [['entryPlan',100],['entries',1000],['closes',1000],['events',1000]]){
    const result=lifecycleSchema.safeParse({...blankTrade('2026-01-01'),[field]:Array(limit+1).fill(null)});
    assert.equal(result.success,false,field);
    const issues=result.error.issues.filter(i=>i.path[0]===field);
    assert.equal(issues.length,1,field+' should short-circuit');
    assert.equal(issues[0].code,'too_big');
  }
});

test('Zod 4 migration retains nullable checklist values and unknown snapshot fields',()=>{
  const plan=blankG1(); plan.checks.futureCheck=null;
  assert.deepEqual(g1PlanSchema.parse(plan),plan);
  const trade={...blankTrade('2026-01-01'),originalPlan:{capturedAt:'2026-01-01T00:00:00Z',data:{future:{flag:true},empty:null}}};
  assert.deepEqual(lifecycleSchema.parse(trade).originalPlan,trade.originalPlan);
});

test('oversized invalid collection stays bounded in a memory-limited process',()=>{
  const code="import {blankTrade,lifecycleSchema} from './lib/trading.ts'; const r=lifecycleSchema.safeParse({...blankTrade('2026-01-01'),entries:Array(100000).fill(null)}); if(r.success || r.error.issues.length!==1 || r.error.issues[0].code!=='too_big')process.exit(2);";
  const result=spawnSync(process.execPath,['--max-old-space-size=64','--input-type=module','-e',code],{cwd:new URL('../',import.meta.url),encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.error,undefined);
});
