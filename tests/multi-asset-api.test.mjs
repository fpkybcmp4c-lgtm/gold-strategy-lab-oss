import test from 'node:test';
import assert from 'node:assert/strict';
import {apiHarness} from './api-harness.mjs';
import {blankTrade,syncStatus} from '../lib/trading.ts';
import { DEMO_SETTINGS as DEFAULT_SETTINGS } from './demo-settings.mjs';
import {saveSettings} from '../lib/repository.ts';
const contract={confirmed:true,currency:'USD',settlement:'linear',usdPerPriceUnit:10,entryFeePerQty:2,exitFeePerQty:2,slippagePrice:0,quantityStep:1};
const fixture=instrument=>({...blankTrade('2026-10-20'),instrument,symbol:instrument+'-TEST',accountId:instrument==='XAU'?'legacy':instrument+'-account',researchModel:instrument==='XAU'?undefined:'隔离测试模型',framework:'pending',openedTime:'09:00:00',direction:'long',entryPrice:100,quantity:2,originalStop:90,currentStop:90,targetPrice:120,contract,aggregateEntryFee:4,initialRisk:208,recordType:'executed'});
test('three instruments persist add/edit/reload and owner isolation through actual API + SQLite; no production writes',async()=>{
 const h=apiHarness();try{await saveSettings(h.db,'A',{...DEFAULT_SETTINGS,multiAsset:{instruments:{NQ:{normalRisk:300,riskLimit:500},BTC:{normalRisk:300,riskLimit:500}}}});
 for(const instrument of ['XAU','NQ','BTC']){
  let response=await h.trades.PUT(h.req('/api/trades','PUT',fixture(instrument)));let payload=await response.json();assert.equal(response.status,200,JSON.stringify(payload));let t=payload.trade;const id=t.id,risk=t.initialRisk;
  t=syncStatus({...t,closes:[{id:id+'-close',date:'2026-10-20',time:'10:00:00',quantity:2,price:110,fees:4,netPnl:0,calculationMode:'automatic',feeSource:'actual',reason:'隔离验收'}]});
  response=await h.trades.PUT(h.req('/api/trades','PUT',t));payload=await response.json();assert.equal(response.status,200,JSON.stringify(payload));assert.equal(payload.trade.closes[0].netPnl,192);assert.equal(payload.trade.initialRisk,risk);assert.equal(payload.trade.id,id);
  response=await h.trades.GET(h.req('/api/trades?id='+id));payload=await response.json();assert.equal(payload.trade.status,'closed');assert.equal(payload.trade.instrument,instrument);assert.equal(payload.history.length,2);
  h.setUser({userId:'B'});assert.equal((await h.trades.GET(h.req('/api/trades?id='+id))).status,404);h.setUser({userId:'A'});
 }
 const data=await (await h.records.GET()).json();assert.equal(data.trades.length,3);assert.equal(h.sql.prepare('SELECT COUNT(*) n FROM trade_records').get().n,3);
 }finally{h.sql.close();}
});
test('new records require explicit instrument; existing execution cannot change account/instrument/contract or frozen independent rules',async()=>{
 const h=apiHarness();try{let t=fixture('NQ');delete t.instrument;assert.equal((await h.trades.PUT(h.req('/api/trades','PUT',t))).status,400);
 t=fixture('BTC');let response=await h.trades.PUT(h.req('/api/trades','PUT',t));let payload=await response.json();assert.equal(response.status,200,JSON.stringify(payload));t=payload.trade;
 for(const patch of [{instrument:'XAU'},{accountId:'other'},{contract:{...contract,usdPerPriceUnit:100}},{instrumentRiskSnapshot:{...t.instrumentRiskSnapshot,riskLimit:999999}}])assert.equal((await h.trades.PUT(h.req('/api/trades','PUT',{...t,...patch}))).status,400);
 assert.equal(h.sql.prepare('SELECT COUNT(*) n FROM record_history').get().n,1);
 }finally{h.sql.close();}
});
