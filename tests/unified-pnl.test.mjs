import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_SETTINGS as DEFAULT_SETTINGS } from './demo-settings.mjs';
import { blankTrade, syncStatus, totalRealized } from '../lib/trading.ts';
import { calculateTradePnl, calculationContractReady, closeCalculation, estimatedExecutionFee, planCalculation, refreshAutomaticCloses } from '../lib/calculations.ts';
import { multiAssetSummary } from '../lib/multi-asset.ts';

// Isolated arithmetic fixtures only: no production network, database, accounts or writes.
const day='2026-10-20',settings={...DEFAULT_SETTINGS,start:'2026-10-01',end:'2026-10-31'};
const contract=(multiplier=1,currency='USD')=>({confirmed:true,currency,settlement:'linear',usdPerPriceUnit:multiplier,feeMode:'perQuantity',entryFeePerQty:1,exitFeePerQty:1,slippagePrice:0,quantityStep:0.00000001});
const entry=(id,quantity,price,fees,date=day,time='09:00:00')=>({id,quantity,price,fees,date,time,rationale:'隔离数学验算',inPlan:true,lossAdd:false,feeSource:'actual'});
const close=(id,quantity,price,fees,date=day,time='10:00:00')=>({id,quantity,price,fees,date,time,netPnl:999,reason:'隔离数学验算',calculationMode:'automatic',feeSource:'actual'});
function fixture(instrument,price,exitPrice,quantity,multiplier,entryFee,exitFee,currency='USD'){
  return syncStatus({...blankTrade(day),instrument,symbol:instrument==='NQ'?'MNQ':instrument==='BTC'?'BTCUSDT':'XAU',accountId:'isolated-'+instrument,direction:'long',initialRisk:20,contract:contract(multiplier,currency),entries:[entry('e',quantity,price,entryFee)],closes:[close('c',quantity,exitPrice,exitFee)]});
}
function near(actual,expected){assert.ok(Math.abs(actual-expected)<1e-8,`${actual} should equal ${expected} within 8-decimal currency precision`);}

for(const [label,args,gross,net] of [
  ['A XAU',[ 'XAU',4200,4210,2,1,3,3 ],20,14],
  ['B MNQ',[ 'NQ',20000,20010,1,2,2,2 ],20,16],
  ['C BTC linear USDT',[ 'BTC',60000,61000,0.1,1,3,3.05,'USDT' ],100,93.95],
])test(`fixed acceptance ${label}: price difference × quantity × multiplier less actual costs`,()=>{
  const t=fixture(...args),before=JSON.stringify(t),p=closeCalculation(t,t.closes[0],settings),summary=calculateTradePnl(t,settings);
  assert.equal(p.gross,gross);assert.equal(p.net,net);assert.equal(summary.grossPnl,gross);assert.equal(summary.netPnl,net);assert.equal(summary.incurredFees,args[5]+args[6]);assert.equal(summary.totalFees,args[5]+args[6]);assert.equal(JSON.stringify(t),before);
  const refreshed=refreshAutomaticCloses(t,settings);assert.equal(refreshed.closes[0].netPnl,net);assert.equal(totalRealized(refreshed),net);
  const statistics=multiAssetSummary([refreshed],settings,{start:settings.start,end:settings.end,instrument:args[0]});assert.equal(statistics.closedCount,1);near(statistics.totalR,net/20);
});

test('short wins and both long/short stop-outs use the direction sign exactly once',()=>{
  const short={...fixture('XAU',4200,4190,2,1,3,3),direction:'short'};assert.equal(calculateTradePnl(short,settings).grossPnl,20);assert.equal(calculateTradePnl(short,settings).netPnl,14);
  const longStop=fixture('XAU',100,90,2,1,3,3),shortStop={...fixture('XAU',100,110,2,1,3,3),direction:'short'};
  for(const t of [longStop,shortStop]){assert.equal(calculateTradePnl(t,settings).grossPnl,-20);assert.equal(calculateTradePnl(t,settings).netPnl,-26);}
});
test('notional fee estimates use actual fill price and side; actual recorded fee overrides the schedule',()=>{
  const t=fixture('BTC',60000,61000,0.1,1,3,3.05,'USDT');t.contract={...t.contract,feeMode:'notional',entryFeeRate:0.0005,exitFeeRate:0.0005,entryFeePerQty:null,exitFeePerQty:null};
  assert.equal(estimatedExecutionFee(t.contract,0.1,60000,'entry'),3);assert.equal(estimatedExecutionFee(t.contract,0.1,61000,'exit'),3.05);assert.equal(calculateTradePnl(t,settings).netPnl,93.95);
  t.entries[0].fees=10;t.closes[0].fees=20;assert.equal(calculateTradePnl(t,settings).netPnl,70);assert.equal(calculateTradePnl(t,settings).incurredFees,30);
});
test('interleaved scale-in, partial exit and multiple exits consume moving basis and entry fees once',()=>{
  const t=syncStatus({...blankTrade(day),instrument:'XAU',direction:'long',contract:contract(1),initialRisk:50,entries:[entry('e1',2,100,2,day,'09:00:00'),entry('e2',2,120,4,day,'11:00:00')],closes:[close('c1',1,110,1,day,'10:00:00'),close('c2',1,120,1,day,'12:00:00'),close('c3',2,100,2,day,'13:00:00')]});
  const p=calculateTradePnl(t,settings);near(p.closes[0].gross,10);near(p.closes[1].gross,20/3);near(p.closes[2].gross,-80/3);near(p.grossPnl,-10);assert.equal(p.totalEntryFees,6);assert.equal(p.allocatedEntryFees,6);assert.equal(p.totalExitFees,4);assert.equal(p.totalFees,10);assert.equal(p.netPnl,-20);assert.equal(p.netR,-0.4);
  const partial=syncStatus({...t,closes:t.closes.slice(0,1)}),pp=calculateTradePnl(partial,settings);assert.equal(pp.netPnl,8);assert.equal(pp.allocatedEntryFees,1);assert.equal(pp.incurredFees,7);assert.equal(pp.totalFees,2);assert.equal(pp.netR,null);
});
test('fractional allocation carries monetary rounding remainder into later exits without losing entry fees',()=>{
  const t=syncStatus({...blankTrade(day),direction:'long',contract:contract(),entries:[entry('e',3,100,0.01)],closes:[close('a',1,100,0,day,'10:00:00'),close('b',1,100,0,day,'11:00:00'),close('c',1,100,0,day,'12:00:00')]});
  const p=calculateTradePnl(t,settings);assert.deepEqual(p.closes.map(c=>c.allocatedEntryFee),[0.00333333,0.00333334,0.00333333]);assert.equal(p.allocatedEntryFees,0.01);assert.equal(p.netPnl,-0.01);
});
test('unknown entry or exit fees stay unknown and are not filled from configuration or zero',()=>{
  const t=fixture('XAU',100,110,2,1,null,3);let p=calculateTradePnl(t,settings);assert.equal(p.totalEntryFees,null);assert.equal(p.incurredFees,null);assert.equal(p.netPnl,null);assert.equal(p.ready,false);
  t.entries[0].fees=0;t.closes[0].fees=null;p=calculateTradePnl(t,settings);assert.equal(p.totalEntryFees,0);assert.equal(p.totalExitFees,null);assert.equal(p.netPnl,null);
  t.closes[0].fees=0;p=calculateTradePnl(t,settings);assert.equal(p.netPnl,20);assert.equal(p.totalFees,0);
});
test('a fully consumed unknown historical entry fee does not poison a later independent inventory',()=>{
  const t=syncStatus({...blankTrade(day),direction:'long',contract:contract(),entries:[entry('e1',1,100,null,day,'09:00:00'),entry('e2',1,200,2,day,'11:00:00')],closes:[{...close('old',1,110,null,day,'10:00:00'),calculationMode:'reported',netPnl:7},close('new',1,210,2,day,'12:00:00')]});
  const p=closeCalculation(t,t.closes[1],settings);assert.equal(p.average,200);assert.equal(p.allocatedEntryFee,2);assert.equal(p.net,6);assert.equal(calculateTradePnl(t,settings).netPnl,13);assert.equal(calculateTradePnl(t,settings).totalEntryFees,null);
});
test('equivalent HH:mm and HH:mm:ss executions match at the same instant',()=>{
  const t=fixture('XAU',100,110,2,1,3,3);t.entries[0].time='09:00:00';t.closes[0].time='09:00';assert.equal(closeCalculation(t,t.closes[0],settings).net,14);
});
test('tiny valid BTC quantities are supported without allowing an absolute tolerance to double-close them',()=>{
  const t=fixture('BTC',60000,61000,0.00000001,1,0,0,'USDT');assert.equal(closeCalculation(t,t.closes[0],settings).gross,0.00001);assert.equal(closeCalculation(t,t.closes[0],settings).ready,true);
  assert.equal(closeCalculation(t,{...t.closes[0],quantity:0.00000002},settings).net,null);
});
test('slippage estimates affect the plan but are never deducted again from actual fill-price PnL',()=>{
  const t=fixture('XAU',4200,4210,2,1,3,3);t.contract.slippagePrice=5;t.originalStop=4190;t.targetPrice=4210;
  assert.equal(planCalculation(t,settings).slippage,10);assert.equal(calculateTradePnl(t,settings).netPnl,14);assert.equal(closeCalculation(t,t.closes[0],settings).net,14);
});
test('only finite positive initial risk on a completed lifecycle produces R; later stops cannot replace its denominator',()=>{
  const t=fixture('XAU',4200,4210,2,1,3,3);assert.equal(calculateTradePnl({...t,initialRisk:20},settings).netR,0.7);
  for(const risk of [null,0,-20,NaN,Infinity])assert.equal(calculateTradePnl({...t,initialRisk:risk},settings).netR,null);
  assert.equal(calculateTradePnl({...t,initialRisk:20,originalStop:4190,currentStop:4205},settings).netR,0.7);
});
test('broker-reported net values and original snapshots survive refresh; explicit automatic edits recalculate locally',()=>{
  const t=fixture('XAU',4200,4210,2,1,3,3);t.closes[0]={...t.closes[0],calculationMode:'reported',netPnl:12.34567891};t.originalPlan={capturedAt:'2026-10-20T00:00:00Z',data:{initialRisk:20,fees:6}};
  const before=JSON.stringify(t),p=calculateTradePnl(t,settings),refreshed=refreshAutomaticCloses(t,settings);assert.equal(p.netPnl,12.34567891);assert.equal(p.grossPnl,null);assert.equal(p.totalFees,null);assert.deepEqual(refreshed,t);assert.equal(JSON.stringify(t),before);
  const automatic={...t,closes:[{...t.closes[0],calculationMode:'automatic',price:4220,fees:4}]},calculated=refreshAutomaticCloses(automatic,settings);assert.equal(calculated.closes[0].grossPnl,40);assert.equal(calculated.closes[0].netPnl,33);assert.deepEqual(calculated.originalPlan,t.originalPlan);assert.equal(calculated.initialRisk,20);
});
test('nonlinear, mismatched fee currencies and incomplete or nonfinite specifications never produce automatic settlement',()=>{
  for(const patch of [{settlement:'inverse'},{settlement:'quanto'},{feeCurrency:'CNY'},{confirmed:false},{usdPerPriceUnit:null},{usdPerPriceUnit:NaN},{currency:'UNKNOWN'}]){
    const t=fixture('BTC',60000,61000,0.1,1,3,3.05,'USDT');t.contract={...t.contract,...patch};assert.equal(closeCalculation(t,t.closes[0],settings).net,null);assert.equal(calculateTradePnl(t,settings).ready,false);
  }
  for(const patch of [{slippagePrice:undefined},{slippagePrice:NaN},{entryFeePerQty:undefined},{exitFeePerQty:NaN},{feeMode:'notional',entryFeeRate:NaN,exitFeeRate:0.001}])assert.equal(calculationContractReady({...contract(),...patch}),false);
});
test('plan estimates preserve known manual fill fees while estimating only missing fill fees',()=>{
  const t={...fixture('XAU',100,110,2,1,0,0),originalStop:90,targetPrice:110,entries:[entry('e1',1,100,10),entry('e2',1,100,null)]};
  const p=planCalculation(t,settings);assert.equal(p.entryFees,11);assert.equal(p.estimatedEntryFee,true);assert.equal(p.fees,13);
});
