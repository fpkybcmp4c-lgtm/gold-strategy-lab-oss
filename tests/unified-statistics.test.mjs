import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_SETTINGS as DEFAULT_SETTINGS } from './demo-settings.mjs';
import { blankTrade, g1Side, syncStatus } from '../lib/trading.ts';
import { blankG1, DEFAULT_G1 } from '../lib/g1-schema.ts';
import { emptyG1Filters, g1Review, g1Stats } from '../lib/g1-stats.ts';
import { multiAssetSummary } from '../lib/multi-asset.ts';

// Read-only, isolated fixtures. Nothing here represents or writes a real user's trades.
const settings={...DEFAULT_SETTINGS,start:'2026-10-10',end:'2026-10-31',capital:1000,multiAsset:{baseCurrency:'USD',accounts:[{id:'gold',name:'隔离XAU',currency:'USD',capital:1000},{id:'nq',name:'隔离NQ',currency:'USD',capital:2000},{id:'btc',name:'隔离BTC',currency:'USDT',capital:3000}]}};
function saved(id,instrument,model,framework,net,date='2026-10-20',time='10:00:00'){
 const currency=instrument==='BTC'?'USDT':'USD',contract={confirmed:true,currency,usdPerPriceUnit:1,entryFeePerQty:0,exitFeePerQty:0,slippagePrice:0,quantityStep:0.1,settlement:'linear'};
 return syncStatus({...blankTrade('2026-10-10'),id,instrument,accountId:instrument==='XAU'?'gold':instrument.toLowerCase(),model,framework,strategy:framework==='G1'?'G1-L':'none',direction:'long',entryPrice:100,quantity:1,initialRisk:100,aggregateEntryFee:0,contract,g1:framework==='G1'?{...blankG1({...DEFAULT_G1,contract}),side:'long',marketState:'trend'}:undefined,closes:[{id:id+'-close',date,time,quantity:1,price:110,fees:0,netPnl:net,reason:'隔离统计验算',calculationMode:'reported'}]});
}
const range={start:settings.start,end:settings.end};

test('shared G1/L1/L2/S1/S2 classification counts real parent records across three instruments with native-currency isolation',()=>{
 const xau=saved('x','XAU','L1','G1',100),nq=saved('n','NQ','L2','G1',-50),btc=saved('b','BTC','S1','G1',93.95),independent=saved('i','BTC','S2','independent',-20);
 assert.equal(g1Side(nq),'long');assert.equal(g1Side(btc),'long');assert.equal(g1Side(independent),null);
 const usd=g1Stats([xau,nq,btc,independent],[],settings),usdt=g1Stats([xau,nq,btc,independent],[],settings,{...emptyG1Filters(settings),currency:'USDT'});
 assert.equal(usd.closedCount,2);assert.equal(usd.netPnl,50);assert.equal(usd.totalR,0.5);assert.equal(usdt.closedCount,1);assert.equal(usdt.netPnl,93.95);
 const all=multiAssetSummary([xau,nq,btc,independent],settings,range);assert.equal(all.tradeCount,4);assert.equal(all.netPnl,null);assert.deepEqual(all.strategyModels.map(g=>g.key).sort(),['BTC × G1 × S1','BTC × 非G1 × S2','NQ × G1 × L2','XAU × G1 × L1'].sort());
});

test('G1 weekly/monthly review accepts USDT without changing global USD account settings',()=>{
 const xau=saved('x','XAU','L1','G1',100),btc=saved('b','BTC','L2','G1',93.95),before=JSON.stringify(settings);
 const review=g1Review([xau,btc],[],[],settings,range.start,range.end,'USDT');
 assert.equal(review.stats.currency,'USDT');assert.equal(review.stats.closedCount,1);assert.equal(review.stats.netPnl,93.95);assert.equal(review.directions.find(d=>d.side==='long').stats.netPnl,93.95);assert.equal(JSON.stringify(settings),before);
 assert.equal(g1Review([xau,btc],[],[],settings,range.start,range.end).stats.netPnl,100);
});

test('G1 account drawdowns and exported curve do not manufacture a combined account from separate capitals',()=>{
 const xau=saved('x','XAU','L1','G1',-100,'2026-10-20','10:00:00'),nq=saved('n','NQ','L2','G1',500,'2026-10-20','11:00:00');
 const stats=g1Stats([xau,nq],[],settings);assert.equal(stats.netPnl,400);assert.equal(stats.maxAccountDrawdown,null);assert.equal(stats.maxAccountDrawdownPct,null);assert.ok(stats.curve.every(point=>point.accountDrawdown===null));
 const separate=multiAssetSummary([xau,nq],settings,range);assert.equal(separate.accountCurves.length,2);assert.equal(separate.accountCurves.find(c=>c.accountId==='gold').maxDrawdown,100);assert.equal(separate.accountCurves.find(c=>c.accountId==='nq').maxDrawdown,0);
});

test('MAE/MFE price points split by instrument while original single-gold point statistics stay compatible',()=>{
 const excursion=value=>({value,unit:'points',source:'manual',note:'隔离人工记录'}),xau={...saved('x','XAU','L1','G1',10),research:{mae:excursion(2),mfe:excursion(8),slippageCost:null}},nq={...saved('n','NQ','L2','G1',20),research:{mae:excursion(200),mfe:excursion(800),slippageCost:null}};
 const mixed=g1Stats([xau,nq],[],settings);assert.equal(mixed.mae.find(g=>g.unit==='XAU · points').average,2);assert.equal(mixed.mae.find(g=>g.unit==='NQ · points').average,200);assert.equal(mixed.mae.find(g=>g.unit==='points'),undefined);assert.equal(mixed.mfe.find(g=>g.unit==='NQ · points').average,800);
 assert.equal(g1Stats([xau],[],settings).mae.find(g=>g.unit==='points').average,2);
});

test('research uses recorded entry execution approach consistently instead of a false missing label',()=>{
 const t=saved('n','NQ','L2','G1',20);t.entrySnapshot={...t.entrySnapshot,regime:'trend_pullback',entryApproach:'breakout_retest'};
 const summary=multiAssetSummary([t],settings,range);assert.equal(summary.environments[0].key,'趋势回踩');assert.equal(summary.executionModes[0].key,'突破后回测确认');assert.ok(summary.research[0].key.endsWith(summary.executionModes[0].key));
});

test('account baseline excludes pre-validation cash and retains the earlier in-period high water before a later filter',()=>{
 const old=saved('old','XAU','L1','G1',999,'2026-10-09'),rise=saved('rise','XAU','L1','G1',100,'2026-10-11'),fall=saved('fall','XAU','L1','G1',-50,'2026-10-12');
 const result=multiAssetSummary([old,rise,fall],settings,{start:'2026-10-12',end:range.end});assert.equal(result.basisStart,settings.start);assert.equal(result.accountCurves[0].basisStart,settings.start);assert.equal(result.accountCurves[0].points[0].equity,1050);assert.equal(result.accountCurves[0].maxDrawdown,50);assert.equal(result.netPnl,-50);
});
