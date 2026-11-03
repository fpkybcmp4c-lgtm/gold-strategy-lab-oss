import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_SETTINGS as DEFAULT_SETTINGS } from './demo-settings.mjs';
import { settingsSchema } from '../lib/domain.ts';
import { DEFAULT_G1, contractSchema } from '../lib/g1-schema.ts';
import { blankTrade, g1Side, lifecycleSchema, syncStatus, totalRealized } from '../lib/trading.ts';
import { closeCalculation, estimatedExecutionFee, planCalculation, refreshAutomaticCloses, tradeContract } from '../lib/calculations.ts';
import { accountOf, instrumentConfig, instrumentOf, multiAssetSummary, conversionRate } from '../lib/multi-asset.ts';
import { vnextRiskAssessment } from '../lib/vnext.ts';

// Pure, isolated mathematical fixtures. This file never accesses the production repository.
const contract = { confirmed:true,usdPerPriceUnit:10,entryFeePerQty:2,exitFeePerQty:2,slippagePrice:0.5,quantityStep:1,currency:'USD',settlement:'linear',feeMode:'perQuantity' };
const settings = { ...DEFAULT_SETTINGS, start:'2026-10-01',end:'2026-10-31',g1:{...DEFAULT_G1,contract}, multiAsset:{baseCurrency:'USD',accounts:[{id:'nq',name:'纳指测试账户',currency:'USD',capital:1000}],instruments:{NQ:{symbol:'明确合约',accountId:'nq',contract,models:['自定义模型'],riskLimit:200,normalRisk:100}}} };
const range = { start:settings.start,end:settings.end };
const entry = (id,q,price,date='2026-10-10',fees=2*q) => ({id,quantity:q,price,date,time:'09:00:00',fees,rationale:'隔离数学用例',inPlan:true,lossAdd:false});
const close = (id,q,price,date='2026-10-11',netPnl=0) => ({id,quantity:q,price,date,time:'10:00:00',fees:2*q,netPnl,reason:'隔离数学用例',calculationMode:'reported'});
const base = () => ({...blankTrade('2026-10-10'),openedTime:'09:00:00',direction:'long',model:'其他',instrument:'NQ',accountId:'nq',researchModel:'自定义模型',entryPrice:100,quantity:2,originalStop:90,currentStop:90,targetPrice:120,initialRisk:200,aggregateEntryFee:4,contract});
const reported = (id,n,instrument='XAU',currency='USD',accountId=undefined,date='2026-10-11') => syncStatus({...base(),id,instrument,accountId,contract:{...contract,currency},quantity:1,initialRisk:100,closes:[close(id+'-close',1,101,date,n)]});

test('optional schema preserves exact historical fields; missing instrument reads as XAU without mutation',()=>{
  const old={...blankTrade('2026-10-10'),customHistorical:{fee:12.345,r:0.739}};
  delete old.instrument;const before=JSON.stringify(old),parsed=lifecycleSchema.parse(old);
  assert.equal(instrumentOf(parsed),'XAU');assert.equal(JSON.stringify(old),before);assert.equal('instrument' in parsed,false);assert.deepEqual(parsed.customHistorical,old.customHistorical);
  assert.deepEqual(settingsSchema.parse(DEFAULT_SETTINGS),DEFAULT_SETTINGS);
  assert.equal(lifecycleSchema.safeParse({...old,instrument:'ETH'}).success,false);
});
test('NQ/BTC share strategy models while contract and actual risk amounts stay isolated',()=>{
  const nq=instrumentConfig(DEFAULT_SETTINGS,'NQ'),btc=instrumentConfig(settings,'BTC');
  assert.equal(nq.riskLimit,null);assert.equal(nq.normalRisk,null);assert.equal(nq.contract.confirmed,false);assert.deepEqual(nq.models,['S1','S2','L1','L2','G1','其他']);assert.equal(btc.contract.usdPerPriceUnit,null);
  const unconfigured={...base(),instrument:'BTC',contract:undefined,g1:{contract}};
  assert.equal(tradeContract(unconfigured,settings).confirmed,false);assert.equal(planCalculation(unconfigured,settings).totalRisk,null);
  assert.equal(g1Side({...base(),framework:'G1',strategy:'G1-L'}),'long');assert.equal(instrumentConfig(settings,'NQ').riskLimit,200);
  assert.equal(accountOf({...base(),accountId:undefined}),'unassigned:NQ');
});
test('actual partial fills allocate entry fees once and do not deduct slippage twice',()=>{
  let t=syncStatus({...base(),entries:[entry('e',2,100)],closes:[{...close('c1',1,110),calculationMode:'automatic'},{...close('c2',1,90,'2026-10-12'),calculationMode:'automatic'}]});
  t=refreshAutomaticCloses(t,settings);
  assert.equal(t.closes[0].netPnl,96);assert.equal(t.closes[1].netPnl,-104);assert.equal(totalRealized(t),-8);assert.equal(t.initialRisk,200);
  assert.equal(t.closes[0].allocatedEntryFee,2);assert.equal(t.closes[1].allocatedEntryFee,2);
  assert.equal(lifecycleSchema.safeParse(t).success,true);
  const result=multiAssetSummary([t],settings,range);assert.equal(result.closedCount,1);assert.equal(result.totalR,-0.04);assert.equal(result.periods.day.length,2);
});
test('notional fee calculation uses each fill price, multiplier and fee side',()=>{
  const c={...contract,feeMode:'notional',entryFeePerQty:null,exitFeePerQty:null,entryFeeRate:0.001,exitFeeRate:0.002};
  assert.equal(estimatedExecutionFee(c,2,100,'entry'),2);assert.equal(estimatedExecutionFee(c,2,110,'exit'),4.4);
  const p=planCalculation({...base(),contract:c,aggregateEntryFee:null},settings);
  assert.equal(p.entryFees,2);assert.equal(p.exitFees,3.6);assert.equal(p.priceRisk,200);assert.equal(p.totalRisk,215.6);assert.equal(p.targetNet,383.2);
  const t={...base(),contract:c,aggregateEntryFee:2},event={...close('c',2,110),fees:4.4};assert.equal(closeCalculation(t,event,settings).net,193.6);
});
test('inverse or mismatched fee currency cannot use a linear settlement formula',()=>{
  const inverse={...base(),contract:{...contract,settlement:'inverse'}};
  assert.equal(planCalculation(inverse,settings).totalRisk,null);assert.equal(closeCalculation(inverse,close('c',1,110),settings).net,null);
  assert.equal(estimatedExecutionFee(inverse.contract,1,100,'entry'),null);
  assert.equal(contractSchema.safeParse({...contract,feeCurrency:'CNY'}).success,false);
});
test('reported historical close values remain exact after parameter changes and automatic refresh',()=>{
  const t=reported('historical',123.456789);t.closes[0].fees=9.98765;const before=JSON.stringify(t),after=refreshAutomaticCloses(t,{...settings,g1:{...DEFAULT_G1,contract:{...contract,usdPerPriceUnit:999}}});
  assert.deepEqual(after,t);assert.equal(JSON.stringify(t),before);assert.equal(after.closes[0].netPnl,123.456789);assert.equal(after.closes[0].fees,9.98765);
});
test('mixed currency totals require confirmed sourced rates on each realized cash date',()=>{
  const trades=[reported('gold',100),reported('btc',700,'BTC','CNY','btc')];
  const noFx=multiAssetSummary(trades,settings,range);assert.equal(noFx.netPnl,null);assert.equal(noFx.conversionComplete,false);assert.equal(noFx.currencyBuckets.length,2);assert.equal(noFx.missingConversions.length,1);
  const fx={...settings,multiAsset:{...settings.multiAsset,fxRates:[{from:'CNY',to:'USD',rate:1/7,date:'2026-10-11',source:'确认的隔离测试汇率',confirmed:true}]}};
  const yes=multiAssetSummary(trades,fx,range);assert.equal(yes.netPnl,200);assert.equal(yes.conversionComplete,true);assert.equal(yes.totalR,8);
  assert.equal(conversionRate(fx,'CNY','USD','2026-10-12'),null);assert.equal(conversionRate(fx,'USDT','USD','2026-10-11'),null);
  fx.multiAsset.fxRates[0].confirmed=false;assert.equal(multiAssetSummary(trades,fx,range).netPnl,null);
});
test('conflicting direct/inverse FX and unknown currency never silently produce totals',()=>{
  const fx={...settings,multiAsset:{...settings.multiAsset,fxRates:[{from:'CNY',to:'USD',rate:0.14,date:'2026-10-11',source:'test',confirmed:true},{from:'USD',to:'CNY',rate:8,date:'2026-10-11',source:'test',confirmed:true}]}};
  assert.equal(conversionRate(fx,'CNY','USD','2026-10-11'),null);
  assert.equal(multiAssetSummary([{...reported('n',10,'NQ'),contract:undefined}],DEFAULT_SETTINGS,range).netPnl,null);
});
test('separate accounts retain separate drawdowns and never average percentages',()=>{
  const a=reported('a',-100,'NQ','USD','nq'),b=reported('b',200,'XAU','USD','legacy');
  const s=multiAssetSummary([a,b],settings,range);assert.equal(s.netPnl,100);assert.equal(s.maxDrawdown,null);assert.equal(s.maxDrawdownPct,null);assert.equal(s.accountCurves.length,2);
  const nq=s.accountCurves.find(a=>a.accountId==='nq');assert.equal(nq.maxDrawdown,100);assert.equal(nq.maxDrawdownPct,10);assert.equal(nq.points[0].equity,900);
  const filtered=multiAssetSummary([a,b],settings,{...range,accountId:'nq'});assert.equal(filtered.netPnl,-100);assert.equal(filtered.tradeCount,1);assert.equal(filtered.maxDrawdown,100);
});
test('drawdown retains the pre-filter high water mark and periods use close dates',()=>{
  const trades=[reported('early',100,'NQ','USD','nq','2026-10-05'),reported('late',-50,'NQ','USD','nq','2026-10-12')];
  const s=multiAssetSummary(trades,settings,{start:'2026-10-10',end:'2026-10-31'});
  assert.equal(s.netPnl,-50);assert.equal(s.maxDrawdown,50);assert.equal(s.accountCurves[0].points[0].cumulative,50);assert.equal(s.periods.month[0].netPnl,-50);
});
test('R counts completed parents once; partial exits, plans and archives do not fabricate completed samples',()=>{
  const partial=syncStatus({...base(),id:'p',closes:[close('p1',1,110,'2026-10-11',50)]}),plan={...base(),id:'plan',recordType:'plan',quantity:null,entryPrice:null},archived={...reported('archive',500),archived:true};
  const s=multiAssetSummary([partial,plan,archived],settings,range);assert.equal(s.netPnl,50);assert.equal(s.closedCount,0);assert.equal(s.totalR,null);assert.equal(s.tradeCount,1);
});
test('asset/model/research filters retain genuine sample counts and incomplete discipline remains unknown',()=>{
  const a=reported('gold',100),b={...reported('nq',-50,'NQ','USD','nq'),researchModel:'回测确认',environment:'趋势',executionMode:'确认后执行',psychology:{discipline:'violated',deviationReasons:['risk_excess'],fomo:8},riskCompliant:false};
  const s=multiAssetSummary([a,b],settings,{...range,instrument:'NQ'});assert.equal(s.tradeCount,1);assert.equal(s.models[0].key,'回测确认');assert.equal(s.disciplineScore,0);assert.equal(s.violations,1);assert.equal(s.fomo,8);assert.equal(s.research[0].key,'NQ × 趋势 × 回测确认 × 确认后执行');
  const legacy=multiAssetSummary([a],settings,range);assert.equal(legacy.disciplineScore,null);assert.equal(legacy.fomo,null);assert.equal(legacy.profitFactor,null);assert.equal(legacy.noLosingTrades,true);
});
test('XAU VNext risk blocks inverse settlement and estimates notional fees at each saved layer price',()=>{
  const c={...contract,feeMode:'notional',entryFeePerQty:null,exitFeePerQty:null,entryFeeRate:0.001,exitFeeRate:0.002};
  const t={...base(),instrument:'XAU',accountId:'legacy',framework:'independent',contract:c,aggregateEntryFee:null,quantity:2,entryPrice:150,targetPrice:200,entryPlan:[{id:'p1',quantity:1,price:100,stop:90,trigger:''},{id:'p2',quantity:1,price:200,stop:180,trigger:''}]};
  const p=vnextRiskAssessment(t,settings);assert.equal(p.entryFees,3);assert.equal(p.exitFees,5.4);assert.equal(p.priceRisk,300);assert.equal(p.totalRisk,318.4);assert.equal(p.netRR,979/318.4);
  const inverse=vnextRiskAssessment({...t,contract:{...c,settlement:'inverse'}},settings);assert.equal(inverse.ready,false);assert.equal(inverse.totalRisk,null);assert.equal(inverse.priceRisk,null);assert.equal(inverse.planAllowed,false);
});
test('XAU VNext notional accounting retains actually recorded costs before estimating remaining exit costs',()=>{
  const c={...contract,feeMode:'notional',entryFeePerQty:null,exitFeePerQty:null,entryFeeRate:0.001,exitFeeRate:0.002};
  const t=syncStatus({...base(),instrument:'XAU',accountId:'legacy',framework:'independent',contract:c,entries:[entry('e',2,100,'2026-10-10',7)],closes:[{...close('c',1,110),fees:3,netPnl:77.12345678}]});
  const before=JSON.stringify(t),p=vnextRiskAssessment(t,settings);assert.equal(p.entryFees,7);assert.equal(p.exitFees,4.8);assert.equal(p.fees,11.8);assert.equal(JSON.stringify(t),before);assert.equal(t.closes[0].netPnl,77.12345678);
});
test('saved regime supplies market environment; unrelated dates and unknown accounts do not fabricate statistics',()=>{
  const early=reported('early',10,'NQ','USD','nq','2026-10-05'),late={...reported('late',10,'NQ','USD','nq','2026-11-05'),openedDate:'2026-11-01'},current={...reported('current',-10,'NQ','USD','nq'),entrySnapshot:{regime:'breakout_retest'}};
  current.entrySnapshot.regime='trend_pullback';
  const s=multiAssetSummary([early,late,current],settings,{start:'2026-10-10',end:range.end});assert.equal(s.tradeCount,1);assert.equal(s.closedCount,1);assert.equal(s.netPnl,-10);assert.equal(s.environments[0].key,'趋势回踩');
  const unknown=multiAssetSummary([{...current,accountId:undefined}],settings,range);assert.equal(unknown.maxDrawdown,null);assert.equal(unknown.maxDrawdownPct,null);assert.equal(unknown.accountCurves[0].accountKnown,false);
});
test('BTC short automatically uses its own multiplier and notional fees instead of gold or NQ parameters',()=>{
  const btcContract={...contract,currency:'USDT',usdPerPriceUnit:0.1,feeMode:'notional',entryFeeRate:0.001,exitFeeRate:0.002,entryFeePerQty:null,exitFeePerQty:null};
  const s={...settings,multiAsset:{...settings.multiAsset,instruments:{...settings.multiAsset.instruments,BTC:{contract:btcContract}}}};
  const t={...base(),instrument:'BTC',direction:'short',contract:undefined,entries:[entry('e',2,100,'2026-10-10',0.02)]},c={...close('c',2,90),fees:0.036};
  const p=closeCalculation(t,c,s);assert.equal(p.gross,2);assert.equal(p.net,1.944);assert.equal(p.currency,'USDT');assert.equal(estimatedExecutionFee(tradeContract(t,s),2,90,'exit'),0.036);
});

test('account capital starts at validation baseline while later filters preserve period high water',()=>{
  const config={...settings,start:'2026-10-10'};
  const outside=reported('outside',1000,'XAU','USD','legacy','2026-10-09');outside.openedDate='2026-10-08';
  const gain=reported('gain',100,'XAU','USD','legacy','2026-10-11');
  const loss=reported('loss',-50,'XAU','USD','legacy','2026-10-12');
  const result=multiAssetSummary([outside,gain,loss],config,{start:'2026-10-12',end:'2026-10-12',accountId:'legacy'});
  assert.equal(result.accountCurves.length,1);assert.equal(result.accountCurves[0].points[0].cumulative,50);
  assert.equal(result.accountCurves[0].points[0].equity,config.capital+50);assert.equal(result.accountCurves[0].maxDrawdown,50);
});
