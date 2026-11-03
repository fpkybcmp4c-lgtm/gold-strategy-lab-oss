import test from 'node:test';
import assert from 'node:assert/strict';
import { apiHarness } from './api-harness.mjs';
import { blankTrade, syncStatus, totalRealized } from '../lib/trading.ts';
import { DEMO_RISK_RULES as DEFAULT_VNEXT_RISK_RULES } from './demo-settings.mjs';
import { blankEntrySnapshot } from '../lib/vnext-schema.ts';
import { DEFAULT_G1 } from '../lib/g1-schema.ts';
import { DEMO_SETTINGS as DEFAULT_SETTINGS } from './demo-settings.mjs';
import { saveSettings } from '../lib/repository.ts';
import { buildReviewData } from '../lib/review-data.ts';

const contract={confirmed:true,usdPerPriceUnit:1,entryFeePerQty:1.7,exitFeePerQty:1.7,slippagePrice:0.1,quantityStep:0.1,minimumQuantity:0.02};
const settings={...DEFAULT_SETTINGS,riskLimit:400,g1:{...DEFAULT_G1,contract,effectiveAt:'2026-10-11T01:00:00Z'}};
function sample(framework='independent',quantity=9){return syncStatus({...blankTrade('2026-10-14'),openedTime:'10:00:00',direction:'short',framework,strategy:framework==='G1'?'G1-S':'none',model:framework==='G1'?'S1':'S2',recordType:'executed',entryPrice:4162,quantity,originalStop:4179,currentStop:4179,targetPrice:4125,contract,initialRisk:null,overNormalReason:'已核对结构止损，确认本笔高于常规预算但在硬上限内',entrySnapshot:{...blankEntrySnapshot(),structure4H:'bull',structure1H:'bear',structure15m:'bear',regime:'transition',entryApproach:'breakout_retest',triggerTypes:['close_breakout','retest_failed'],confirmation:'confirmed',invalidationType:'break_lh',invalidationPrice:4179},entries:[{id:crypto.randomUUID(),date:'2026-10-14',time:'10:00:00',quantity,price:4162,fees:quantity*1.7,feeSource:'estimated',inPlan:true,lossAdd:false,rationale:''}]});}
async function put(h,trade){const r=await h.trades.PUT(h.req('/api/trades','PUT',trade));return {status:r.status,...await r.json()};}
test('isolated D1/API stores G1-S S1 and independent S2 with entry structures, distinct early confirmation, and MCP payload',async()=>{
  const h=apiHarness();try{
    await saveSettings(h.db,'A',settings);
    const g=await put(h,sample('G1')),b=await put(h,sample());assert.equal(g.status,200,g.error);assert.equal(b.status,200,b.error);
    assert.equal(g.trade.strategy,'G1-S');assert.equal(g.trade.framework,'G1');assert.equal(g.trade.model,'S1');
    assert.equal(b.trade.strategy,'none');assert.equal(b.trade.framework,'independent');assert.equal(b.trade.riskRuleSnapshot.hardLimit,200);assert.equal(b.trade.riskRuleSnapshot.effectiveAt,'2026-10-13T05:00:00Z');
    assert.deepEqual([b.trade.entrySnapshot.structure4H,b.trade.entrySnapshot.structure1H,b.trade.entrySnapshot.structure15m],['bull','bear','bear']);
    const early=sample();early.entrySnapshot={...early.entrySnapshot,entryApproach:'early_lh_hl',confirmation:'early'};const e=await put(h,early);assert.equal(e.status,200,e.error);
    const result=await (await h.trades.GET(h.req('/api/trades'))).json();
    const rows=h.sql.prepare('SELECT data FROM trade_records').all().map(r=>JSON.parse(r.data));assert.equal(rows.find(r=>r.id===e.trade.id).entrySnapshot.confirmation,'early');assert.equal(rows.find(r=>r.id===b.trade.id).entrySnapshot.confirmation,'confirmed');
    const payload=buildReviewData({records:[],trades:result.trades,images:[],settings}, {scope:'today',start:'2026-10-14',end:'2026-10-14'},new Date('2026-10-14T04:00:00Z'));
    const read=payload.trades.find(t=>t.id===b.trade.id);assert.equal(read.review.classification.framework,'independent');assert.equal(read.entrySnapshot.structure4H,'bull');
    assert.equal(h.sql.prepare('SELECT COUNT(*) n FROM trade_records').get().n,3);
  }finally{h.sql.close();}
});
test('yellow range requires reason; executed hard excess recorded as violation; forged allowance cannot enlarge limit',async()=>{
  const h=apiHarness();try{
    await saveSettings(h.db,'A',settings);
    let t={...sample(),overNormalReason:''};let r=await put(h,t);assert.equal(r.status,400);assert.match(r.error,/常规/);
    t={...t,overNormalReason:'确认'};r=await put(h,t);assert.equal(r.status,200,r.error);assert(Math.abs(r.trade.initialRisk-184.5)<1e-7);
    const over={...sample('independent',11),riskCompliant:true};r=await put(h,over);assert.equal(r.status,200,r.error);assert.equal(r.trade.riskCompliant,false);assert.equal(r.trade.riskRuleSnapshot.hardLimit,200);
    const forged={...sample('independent',11),riskCompliant:true,riskRuleSnapshot:{...r.trade.riskRuleSnapshot,hardLimit:9999}};r=await put(h,forged);assert.equal(r.status,200,r.error);assert.equal(r.trade.riskRuleSnapshot.hardLimit,200);assert.equal(r.trade.riskCompliant,false);
    const plan={...sample('independent',11),recordType:'plan',entries:[],riskCompliant:true};r=await put(h,plan);assert.equal(r.status,400);assert.match(r.error,/计划/);
  }finally{h.sql.close();}
});
test('partial closes stay under one parent; snapshots and original R freeze across later settings and observations',async()=>{
  const h=apiHarness();try{
    await saveSettings(h.db,'A',settings);let r=await put(h,sample());assert.equal(r.status,200,r.error);let t=r.trade;const initial=t.initialRisk,snapshot=structuredClone(t.entrySnapshot),rule=structuredClone(t.riskRuleSnapshot),original=structuredClone(t.originalPlan);
    const changed={...DEFAULT_VNEXT_RISK_RULES,independent:{...DEFAULT_VNEXT_RISK_RULES.independent,normalMin:30,normalMax:40,hardLimit:50}};
    const response=await h.settings.PUT(h.req('/api/settings','PUT',{riskRules:changed}));assert.equal(response.status,200);
    t=syncStatus({...t,closes:[{id:'part',date:'2026-10-14',time:'11:00:00',quantity:4.5,price:4157,fees:7.65,netPnl:7.2,reason:'时间结束',reasons:['time_end'],primaryReason:'time_end',calculationMode:'automatic',feeSource:'actual'}]});
    r=await put(h,t);assert.equal(r.status,200,r.error);t=r.trade;assert.equal(t.status,'partial');assert.equal(t.quantity,9);assert.equal(t.closes.length,1);assert.equal(h.sql.prepare('SELECT COUNT(*) n FROM trade_records').get().n,1);assert.equal(t.initialRisk,initial);assert.deepEqual(t.entrySnapshot,snapshot);assert.deepEqual(t.riskRuleSnapshot,rule);assert.deepEqual(t.originalPlan,original);
    r=await put(h,{...t,entrySnapshot:{...snapshot,confirmation:'early'}});assert.equal(r.status,400);assert.match(r.error,/快照/);
    h.setUser({userId:'B'});assert.equal((await (await h.trades.GET(h.req('/api/trades'))).json()).trades.length,0);h.setUser(null);assert.equal((await h.trades.GET(h.req('/api/trades'))).status,401);
  }finally{h.sql.close();}
});
test('pending plan converts to executed once, captures initial R, and cannot flip its frozen framework',async()=>{
  const h=apiHarness();try{
    await saveSettings(h.db,'A',settings);
    const planned={...sample(),framework:'pending',strategy:undefined,recordType:'plan',entries:[],overNormalReason:'',initialRisk:null};
    let r=await put(h,planned);assert.equal(r.status,200,r.error);assert.equal(r.trade.riskRuleSnapshot,undefined);const original=r.trade.originalPlan;
    r=await put(h,{...r.trade,framework:'independent',strategy:'none',recordType:'executed',overNormalReason:'确认预算',entries:sample().entries});assert.equal(r.status,200,r.error);let t=r.trade;assert(Math.abs(t.initialRisk-184.5)<1e-7);assert.equal(t.entrySnapshot.source,'entry');assert.equal(t.riskRuleSnapshot.framework,'independent');assert.deepEqual(t.originalPlan,original);
    r=await put(h,{...t,framework:'G1',strategy:'G1-S'});assert.equal(r.status,400);assert.match(r.error,/框架/);
  }finally{h.sql.close();}
});
test('real closing costs above normal range can be saved without inventing a pre-entry approval reason',async()=>{
  const h=apiHarness();try{
    await saveSettings(h.db,'A',settings);let t=sample('independent',5);t.overNormalReason='';let r=await put(h,t);assert.equal(r.status,200,r.error);t=r.trade;const initial=t.initialRisk;
    t=syncStatus({...t,closes:[{id:'real-cost',date:'2026-10-14',time:'11:00:00',quantity:5,price:4167,fees:40,feeSource:'actual',netPnl:-73.5,reason:'实际费用确认',calculationMode:'reported'}]});
    r=await put(h,t);assert.equal(r.status,200,r.error);assert.equal(r.trade.closes[0].netPnl,-73.5);assert.equal(r.trade.initialRisk,initial);assert.equal(r.trade.overNormalReason,'');
  }finally{h.sql.close();}
});
