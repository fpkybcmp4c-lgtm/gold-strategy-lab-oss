import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_SETTINGS as DEFAULT_SETTINGS } from './demo-settings.mjs';
import { blankG1, blankInvalidation, blankPsychology, CHECK_IDS, DEFAULT_G1 } from '../lib/g1-schema.ts';
import { allocatedQuantities, allocationClass, compliance, coolingDeadline, inventory, maximumQuantity, permission, riskSnapshot, violations } from '../lib/g1.ts';
import { blankTrade, syncStatus } from '../lib/trading.ts';
import { apiHarness } from './api-harness.mjs';
import { saveSettings } from '../lib/repository.ts';
const contract={confirmed:true,usdPerPriceUnit:1,entryFeePerQty:1,exitFeePerQty:2,slippagePrice:1,quantityStep:.01};
const settings={...DEFAULT_SETTINGS,capital:20000,riskLimit:400,g1:{...DEFAULT_G1,contract}};
const plan=()=>({...blankG1(settings.g1),checks:Object.fromEntries(CHECK_IDS.map(k=>[k,true])),marketState:'trend',triggerClass:'confirmed',resistanceType:'A',resistanceLow:2490,resistanceHigh:2510,riskBudget:240,plannedQty:4});
const entry=(q,p,date='2026-10-10',time='10:00:03')=>({id:crypto.randomUUID(),quantity:q,price:p,fees:q,date,time,rationale:'已核对结构',inPlan:true,lossAdd:false});
const trade=()=>syncStatus({...blankTrade('2026-10-10'),framework:undefined,entrySnapshot:undefined,direction:'short',model:'G1',g1:plan(),openedTime:'10:00:03',entries:[entry(1,2500),entry(1,2510,'2026-10-10','10:30:12'),entry(2,2490,'2026-10-11','12:00:01')],originalStop:2510,currentStop:2510,initialRisk:100,riskCompliant:true});
async function put(h,t){const r=await h.trades.PUT(h.req('/api/trades','PUT',t)),d=await r.json();assert.equal(r.status,200,d.error);return d.trade;}

test('phase 2: checklist permission is independent of execution, ratios are quantities, missing conditions never qualify',()=>{
  const p=plan();assert.equal(permission(p),'qualified');assert.equal(permission({...p,checks:{...p.checks,trendValid:null}}),'incomplete');assert.equal(permission({...p,checks:{...p.checks,noGuessTop:false}}),'rejected');assert.equal(permission({...p,abandoned:true}),'abandoned');assert.equal(permission({...p,triggerClass:'early'}),'rejected');assert.deepEqual(allocatedQuantities(p).map(v=>v.quantity),[1,1,2]);
  assert.equal(allocationClass(trade()),'full112');assert.equal(allocationClass(syncStatus({...trade(),entries:[entry(1,2500)]})),'partial');assert.equal(compliance(trade(),settings),'yes');assert.equal(compliance({...trade(),g1:{...p,contract:{...contract,confirmed:false}}},settings),'unknown');
});
test('phase 2: risk includes scaled price distance, actual entry fees, exit fees and stop slippage; no assumed contract',()=>{
  const t=trade(),r=riskSnapshot(t,settings);assert.equal(r.hypothesisRisk,66);assert.equal(r.openRisk,66);assert.equal(r.riskPct,100*66/20000);assert.equal(maximumQuantity(2500,2510,'short',240,contract),17.14);assert.equal(maximumQuantity(2500,2490,'short',240,contract),null);
  assert.equal(riskSnapshot({...t,g1:{...t.g1,contract:{...contract,usdPerPriceUnit:null}}},settings).hypothesisRisk,null);assert.equal(r.unrealized,null);assert.equal(riskSnapshot({...t,manualQuote:{price:2480,at:'2026-10-11T13:00:00+08:00',source:'manual'}},settings).unrealized,58);
  const big=syncStatus({...t,entries:[entry(100,2500)]});assert.equal(riskSnapshot(big,settings).overHard,true);assert(violations(big,settings).includes('超过硬风险上限'));
});
test('phase 2: after partial close and later scale, remaining cost basis and whole-hypothesis risk are recalculated',()=>{
  const t=syncStatus({...trade(),entries:[entry(2,2500),entry(2,2480,'2026-10-12','10:00:01')],closes:[{id:'exit',date:'2026-10-11',time:'12:00:00',quantity:1,price:2490,fees:2,netPnl:7,reason:'第一止盈'}]});assert.deepEqual(inventory(t),{quantity:3,price:2486.6666666666665,entryFees:3});const r=riskSnapshot(t,settings);assert(Math.abs(r.hypothesisRisk-75)<1e-9);assert.equal(t.initialRisk,100);assert.equal(t.status,'partial');
});
test('phase 2: emotional reverse/cooling and invalidation flags are recorded; candidate waits a full CN 4h candle',()=>{
  assert.equal(coolingDeadline('2026-10-11','10:30:00',1),'2026-10-11T08:00:00.000Z');assert.equal(coolingDeadline('2026-10-11','08:00',1),'2026-10-11T04:00:00.000Z');assert.equal(coolingDeadline(null,null,1),null);
  const t={...trade(),invalidationRecord:{...blankInvalidation(),cause:'hard_stop',stopped:true,heldAfterInvalidation:true,widenedStop:true,immediateReverse:true,independentSetup:false,coolingFollowed:false},psychology:{...blankPsychology(),kolChangedPlan:true}};assert.equal(compliance(t,settings),'no');assert(violations(t,settings).includes('止损后情绪性反手'));assert(violations(t,settings).includes('失效后扛单'));
});
test('phase 2: actual D1 save/reload persists G1 psychology, invalidation and original plan; violations can be saved',async()=>{
  const h=apiHarness();await saveSettings(h.db,'A',settings);let t=await put(h,{...trade(),psychology:{...blankPsychology(),fomo:0,fear:5,energy:3,confidence:7},invalidationRecord:{...blankInvalidation(),date:'2026-10-12',time:'11:22:33',actualExit:'结构失效',widenedStop:true}});assert.equal(t.originalPlan.data.originalStop,2510);const original=t.originalPlan;t=await put(h,{...t,originalStop:2520,g1:{...t.g1,exitPlan:'修改后的退出计划'},riskCompliant:false});assert.deepEqual(t.originalPlan,original);const reload=await (await h.trades.GET(h.req('/api/trades?id='+t.id))).json();assert.equal(reload.trade.psychology.fomo,0);assert.equal(reload.trade.invalidationRecord.time,'11:22:33');assert(reload.history.some(v=>v.changes.some(c=>c.field==='originalStop'&&c.before===2510&&c.after===2520)));
  assert.equal((await h.trades.PUT(h.req('/api/trades','PUT',{...t,originalPlan:{...original,data:{}}}))).status,400);const bad=syncStatus({...trade(),entries:[entry(100,2500)],riskCompliant:true});assert.equal((await h.trades.PUT(h.req('/api/trades','PUT',bad))).status,400);assert.equal((await h.trades.PUT(h.req('/api/trades','PUT',{...bad,riskCompliant:false}))).status,200);h.sql.close();
});
test('phase 2: settings extension preserves saved dates, hard ceiling and unknown fields, audits every change',async()=>{
  const h=apiHarness(),old={...DEFAULT_SETTINGS,capital:20000,riskLimit:400,custom:'保留未知设置'};await saveSettings(h.db,'A',old);const r=await h.settings.PUT(h.req('/api/settings','PUT',{g1:settings.g1}));assert.equal(r.status,200);const saved=(await r.json()).settings;assert.equal(saved.start,old.start);assert.equal(saved.end,old.end);assert.equal(saved.capital,20000);assert.equal(saved.riskLimit,400);assert.equal(saved.custom,old.custom);assert.equal(saved.g1.contract.usdPerPriceUnit,1);assert.equal(h.sql.prepare('SELECT COUNT(*) AS n FROM source_backups').get().n,1);assert.equal((await h.settings.PUT(h.req('/api/settings','PUT',{g1:{...settings.g1,normalRiskMin:0}}))).status,400);h.sql.close();
});
