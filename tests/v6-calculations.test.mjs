import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_SETTINGS as DEFAULT_SETTINGS } from './demo-settings.mjs';
import { blankDay, summarize, assessedDiscipline, equitySeries } from '../lib/domain.ts';
import { blankTrade, syncStatus, totalRealized, g1Side, lifecycleSchema } from '../lib/trading.ts';
import { blankG1, CHECK_IDS } from '../lib/g1-schema.ts';
import { inventory, riskSnapshot } from '../lib/g1.ts';
import { planCalculation, closeCalculation, refreshAutomaticCloses, plannedAllocation, dailyExecutionSummary } from '../lib/calculations.ts';
import { ledgerDays } from '../lib/ledger.ts';
import { g1Stats, emptyG1Filters, g1Review } from '../lib/g1-stats.ts';
import { blankOpportunity } from '../lib/opportunities.ts';
import { apiHarness } from './api-harness.mjs';

const contract={confirmed:true,usdPerPriceUnit:1,entryFeePerQty:1.7,exitFeePerQty:1.7,slippagePrice:.1,quantityStep:.1};
const settings={...DEFAULT_SETTINGS,riskLimit:400,g1:{...blankG1(),normalRiskMin:160,normalRiskMax:240,allocation:[1,1,2],contract,coolingBars:1,confirmationBars:4,atrBuffer:0,confirmationRule:'候选窗口'}};
const base=()=>({...blankTrade('2026-10-11'),framework:undefined,entrySnapshot:undefined,openedTime:'09:00:00',direction:'short',entryPrice:100,quantity:30,originalStop:110,currentStop:110,targetPrice:80,initialRisk:300,contract});
const entry=(id,q,price,date,time,fees)=>({id,quantity:q,price,date,time,fees,rationale:'实际成交',inPlan:true,lossAdd:false});
const close=(id,q,price,date,time,fees)=>({id,quantity:q,price,date,time,fees,feeSource:'actual',netPnl:0,reason:'实际成交',calculationMode:'automatic'});

test('Demo V6: synthetic prices separate gross risk from total costs and preserve input',()=>{
  const t=base(),before=JSON.stringify(t),p=planCalculation(t,settings);
  assert.equal(p.priceRisk,300);assert.equal(p.fees,102);assert.equal(p.slippage,3);assert.equal(p.totalRisk,405);assert.equal(p.targetNet,495);assert.equal(p.overHard,true);assert.equal(p.netRR,495/405);assert.equal(p.maximum,17.7);assert.equal(JSON.stringify(t),before);
  const l=planCalculation({...t,direction:'long',entryPrice:100,originalStop:90,targetPrice:120,quantity:2},settings);assert.equal(l.priceRisk,20);assert.equal(l.targetNet,33);assert.equal(l.totalRisk,27);
});
test('V6: missing costs/specification and mismatched units cannot produce exact risk percentage or executable size',()=>{
  assert.equal(planCalculation({...base(),contract:{...contract,slippagePrice:null}},settings).totalRisk,null);
  assert.equal(planCalculation({...base(),contract:{...contract,confirmed:false}},settings).priceRisk,null);
  const mismatch=planCalculation({...base(),contract:{...contract,currency:'USDT'}},settings);assert.equal(mismatch.currencyMismatch,true);assert.equal(mismatch.riskPct,null);assert.equal(mismatch.maximum,null);assert.equal(mismatch.overHard,null);
  assert.equal(planCalculation({...base(),contract:{...contract,quantityStep:null}},settings).quantityPrecisionKnown,false);
});
test('V6: weighted inventory matches interleaved entry/exit costs, stable initial R and remaining percentages',()=>{
  let t=syncStatus({...base(),quantity:null,entryPrice:null,initialRisk:100,entries:[entry('e1',4,100,'2026-10-11','09:00:00',4),entry('e2',2,110,'2026-10-12','09:00:00',2)],closes:[close('c1',2,90,'2026-10-11','12:00:00',2),close('c2',1,95,'2026-10-12','12:00:00',1)]});
  t=refreshAutomaticCloses(t,settings);assert.equal(t.closes[0].grossPnl,20);assert.equal(t.closes[0].netPnl,16);assert.equal(t.closes[1].grossPnl,10);assert.equal(t.closes[1].netPnl,8);assert.equal(totalRealized(t),24);assert.equal(t.initialRisk,100);assert.equal(inventory(t).quantity,3);assert.equal(inventory(t).price,105);assert.equal(inventory(t).quantity*.25,.75);
  t=syncStatus(refreshAutomaticCloses({...t,closes:[...t.closes,close('c3',3,90,'2026-10-13','12:00:00',3)]},settings));assert.equal(t.status,'closed');assert.equal(totalRealized(t),63);assert.equal(g1Stats([t],[],settings).tradeCount,0);
  const ledger=ledgerDays([blankDay('2026-10-11')],[t]),sum=summarize(ledger,settings);assert.equal(sum.trades,1);assert.equal(sum.closeEvents,3);assert.equal(sum.totalPnl,63);assert.equal(sum.totalR,.63);assert.equal(sum.days,1);
});
test('V6: zero and unknown entry fees remain distinct; historical reported net amounts are never recalculated',()=>{
  const c=close('c',1,86,'2026-10-12','10:00:00',1),old={...base(),closes:[{...c,calculationMode:'reported',netPnl:123.45}]};assert.equal(refreshAutomaticCloses(old,settings).closes[0].netPnl,123.45);assert.equal(closeCalculation(old,c,settings).net,null);
  const p=closeCalculation({...old,aggregateEntryFee:0},c,settings);assert.equal(p.net,13);assert.equal(p.allocatedEntryFee,0);
});
test('V6: independent strategies and models count each ID once, with explicit long/short and plans excluded',()=>{
  const plan=blankG1(settings.g1);plan.checks=Object.fromEntries(CHECK_IDS.map(k=>[k,true]));Object.assign(plan,{resistanceType:'A',resistanceLow:95,resistanceHigh:105,marketState:'trend',triggerClass:'confirmed'});
  const l=syncStatus({...base(),id:'L',strategy:'G1-L',model:'L1',direction:'long',g1:{...plan,side:'long'},entryPrice:100,quantity:1,originalStop:90,currentStop:90,initialRisk:10,closes:[{...close('lc',1,120,'2026-10-12','10:00:00',0),calculationMode:'reported',netPnl:20}]}),s={...l,id:'S',strategy:'G1-S',model:'S1',direction:'short',g1:{...plan,side:'short'},closes:[{...l.closes[0],id:'sc',netPnl:-10}]},other={...s,id:'notG1',strategy:'none'},legacy={...s,id:'legacy',strategy:undefined,model:'G1'},unsupported={...l,id:'unclassifiedLong',strategy:undefined,model:'G1'},planned={...l,id:'planned',recordType:'plan',closes:[]};
  assert.equal(g1Side(other),null);assert.equal(g1Side(unsupported),null);assert.equal(g1Side(legacy),'short');assert.equal(g1Stats([l,s,other,legacy,unsupported,planned],[],settings).tradeCount,3);assert.equal(g1Stats([l,s],[],settings,{...emptyG1Filters(settings),side:'long'}).totalR,2);assert.equal(g1Stats([l,s],[],settings,{...emptyG1Filters(settings),side:'short'}).totalR,-1);
  const total=summarize(ledgerDays([], [l,s,other]),settings);assert.equal(total.trades,3);assert.equal(total.totalPnl,0);assert.equal(summarize(ledgerDays([],[planned]),settings).newTrades,0);assert.equal(lifecycleSchema.safeParse({...planned,entries:[entry('e',1,100,'2026-10-11','09:00:00',0)]}).success,false);
});
test('V6: check-in unknown discipline and FOMO stay unknown while legacy scoring remains identical',()=>{
  const unknown={...blankDay('2026-10-11'),disciplineAssessed:false,fomoRecorded:false},old=blankDay('2026-10-12');assert.equal(assessedDiscipline(unknown),null);assert.equal(summarize([unknown],settings).score,null);assert.equal(summarize([unknown],settings).complianceRate,null);assert.equal(summarize([unknown],settings).fomo,null);assert.equal(summarize([unknown,old],settings).score,100);assert.equal(summarize([unknown,old],settings).disciplineCoverage,1);assert.equal(equitySeries([unknown],settings)[0].score,null);
});
test('V6: quantity allocation is a plan, respects provided step and does not fabricate entries',()=>{
  assert.deepEqual(plannedAllocation(8,[1,1,2],.1),[2,2,4]);assert.deepEqual(plannedAllocation(9,[1,1,2],.1),[2.2,2.2,4.6]);assert.deepEqual(plannedAllocation(null,[1,1,2],null),[null,null,null]);const t={...base(),entryPlan:[{id:'p',quantity:9,price:100,stop:110,trigger:'待确认'}],recordType:'plan'};assert.equal(summarize(ledgerDays([],[t]),settings).newTrades,0);
});
test('V6: daily auto-summary separates hypotheses/executions/closes and actual/estimated fees',()=>{
  const t=syncStatus({...base(),initialRisk:100,entries:[entry('a',1,100,'2026-10-11','09:00:00',1),entry('b',1,101,'2026-10-11','10:00:00',1),entry('c',2,102,'2026-10-11','11:00:00',2)],closes:[{...close('x',1,90,'2026-10-11','12:00:00',1),netPnl:10,feeSource:'estimated'}]});const a=dailyExecutionSummary([t],t.openedDate,settings);assert.equal(a.newTrades,1);assert.equal(a.entries,3);assert.equal(a.partialCloses,1);assert.equal(a.closedTrades,0);assert.equal(a.remaining,3);assert.equal(a.fees,4);assert.equal(a.netR,null);
});
test('V6: server recalculates automatic closes and audits edits; owner isolation and full export remain intact',async()=>{
  const h=apiHarness();await h.settings.PUT(h.req('/api/settings','PUT',settings));let t=syncStatus({...base(),initialRisk:100,riskCompliant:false,entries:[entry('e',4,100,'2026-10-11','09:00:00',4)],closes:[{...close('c',1,90,'2026-10-12','09:00:00',1),netPnl:9999}]});let response=await h.trades.PUT(h.req('/api/trades','PUT',t));assert.equal(response.status,200);t=(await response.json()).trade;assert.equal(t.closes[0].netPnl,8);assert.equal(t.originalPlan.data.initialRisk,100);const original=JSON.stringify(t.originalPlan);t.closes[0].price=80;response=await h.trades.PUT(h.req('/api/trades','PUT',t));assert.equal(response.status,200);t=(await response.json()).trade;assert.equal(t.closes[0].netPnl,18);assert.equal(JSON.stringify(t.originalPlan),original);assert.equal(t.initialRisk,100);const exported=await (await h.records.GET(h.req('/api/records?export=1'))).json();assert.equal(exported.trades.length,1);assert.equal(exported.trades[0].closes[0].netPnl,18);h.setUser({userId:'B'});assert.equal((await (await h.trades.GET(h.req('/api/trades'))).json()).trades.length,0);h.sql.close();
});
test('V6: G1-long opportunities and durable private screenshot association do not create real profit',async()=>{
  const h=apiHarness(),op={...blankOpportunity(settings),plan:{...blankG1(settings.g1),side:'long'},laterMovement:'手动观察，不计入交易收益'};const saved=(await (await h.opportunities.PUT(h.req('/api/opportunities','PUT',op))).json()).opportunity;
  const f=new FormData();f.set('file',new File([Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,0])],'setup.png',{type:'image/png'}));f.set('entityType','opportunity');f.set('opportunityId',saved.id);f.set('tradeId','opportunity:'+saved.id);let response=await h.images.POST(h.req('/api/images','POST',f));assert.equal(response.status,200);const image=(await response.json()).image;assert.equal(image.opportunityId,saved.id);assert.equal((await h.images.GET(h.req('/api/images?id='+image.id))).status,200);assert.equal((await (await h.images.GET(h.req('/api/images?tradeId='+encodeURIComponent('opportunity:'+saved.id)))).json()).images.length,1);assert.equal(g1Review([],[],[saved],settings,settings.start,settings.end).stats.netPnl,0);h.setUser({userId:'B'});assert.equal((await h.images.GET(h.req('/api/images?id='+image.id))).status,404);h.setUser({userId:'A'});assert.equal((await h.images.DELETE(h.req('/api/images?id='+image.id,'DELETE'))).status,200);assert.equal(h.objects.size,0);h.sql.close();
});
test('V6: rule version and effective time update without rewriting original trade snapshots or dates',async()=>{
  const h=apiHarness();let saved=(await (await h.settings.PUT(h.req('/api/settings','PUT',settings))).json()).settings;const first=saved.g1.ruleVersion;const t=(await (await h.trades.PUT(h.req('/api/trades','PUT',{...base(),riskCompliant:false,g1:blankG1(saved.g1)}))).json()).trade;const snapshot=JSON.stringify(t.originalPlan);saved=(await (await h.settings.PUT(h.req('/api/settings','PUT',{...saved,g1:{...saved.g1,confirmationBars:4,takeProfit:{firstR:1.5,firstPercent:50,secondR:2.5,secondPercent:25}}}))).json()).settings;assert.equal(saved.g1.ruleVersion,first+1);assert.ok(saved.g1.effectiveAt);assert.equal(saved.start,settings.start);assert.equal(saved.riskLimit,400);const reloaded=(await (await h.trades.GET(h.req('/api/trades?id='+t.id))).json()).trade;assert.equal(JSON.stringify(reloaded.originalPlan),snapshot);h.sql.close();
});
test('V6: different settlement currencies are excluded from account totals instead of silently converted',()=>{
  const t=syncStatus({...base(),quantity:1,closes:[{...close('c',1,4000,'2026-10-12','10:00:00',0),netPnl:194,calculationMode:'reported'}]}),usdt={...t,id:'usdt',contract:{...contract,currency:'USDT'}};assert.equal(summarize(ledgerDays([],[t,usdt],'USD'),settings).totalPnl,194);assert.equal(summarize(ledgerDays([],[t,usdt],'USDT'),settings).totalPnl,194);
});
