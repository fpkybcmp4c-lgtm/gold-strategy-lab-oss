import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_SETTINGS as DEFAULT_SETTINGS } from './demo-settings.mjs';
import { settingsSchema } from '../lib/domain.ts';
import { DEFAULT_G1 } from '../lib/g1-schema.ts';
import { blankTrade, syncStatus } from '../lib/trading.ts';
import { DEFAULT_UNIFIED_ACCOUNT, accountConfig, accountOf, assetTradeCurrency, instrumentConfig, ledgerCurrency, multiAssetSummary } from '../lib/multi-asset.ts';
import { vnextRiskAssessment } from '../lib/vnext.ts';
import { riskSnapshot } from '../lib/g1.ts';
import { g1Stats } from '../lib/g1-stats.ts';
import { buildReviewData } from '../lib/review-data.ts';

const contract = currency => ({ confirmed: true, currency, settlement: 'linear', feeMode: 'perQuantity', usdPerPriceUnit: 1, entryFeePerQty: 0.5, exitFeePerQty: 0.5, slippagePrice: 0, quantityStep: 0.01 });
// Demo: all balances, identities and transactions in this file are invented.
const demoAccount = { ...DEFAULT_UNIFIED_ACCOUNT, capital: 20000, ledgerUnitCorrection: { confirmed: true, labels: ['USD', 'USDT', 'UNKNOWN'], source: 'Demo: explicitly confirmed fictional ledger labels' } };
const settings = { ...DEFAULT_SETTINGS, capital: 20000, start: '2026-10-01', end: '2026-10-31', g1: { ...DEFAULT_G1, contract: contract('USD'), effectiveAt: '2026-10-01T00:00:00Z' }, multiAsset: { unifiedAccount: demoAccount } };
const range = { start: '2026-10-17', end: '2026-10-19' };
function outcome(id, instrument, currency, accountId, date, pnl) {
  return syncStatus({ ...blankTrade(date), id, instrument, accountId, symbol: instrument === 'NQ' ? 'QQQUSDT.P' : instrument + 'USDT.P', framework: 'G1', strategy: 'G1-L', model: 'L1', openedTime: '09:00:00', direction: 'long', entryPrice: 100, quantity: 1, originalStop: 90, currentStop: 90, initialRisk: 100, contract: contract(currency), entries: [{ id: id + ':entry', date, time: '09:00:00', price: 100, quantity: 1, fees: 0.5, feeSource: 'actual', inPlan: true, lossAdd: false, rationale: '' }], closes: [{ id: id + ':close', date, time: '10:00:00', price: 110, quantity: 1, fees: 0.5, feeSource: 'actual', netPnl: pnl, calculationMode: 'reported', reason: '' }] });
}
const trades = [outcome('gold', 'XAU', 'USD', undefined, '2026-10-17', 100), outcome('nasdaq', 'NQ', 'UNKNOWN', 'demo-account', '2026-10-18', -40), outcome('bitcoin', 'BTC', 'USDT', 'wrong-split-account', '2026-10-19', 50)];

test('confirmed ledger label correction unifies the original account without changing raw records or assuming an FX rate', () => {
  const before = JSON.stringify(trades);
  assert.equal(settingsSchema.safeParse(settings).success, true);
  assert.deepEqual(settingsSchema.parse(DEFAULT_SETTINGS), DEFAULT_SETTINGS);
  assert.equal(ledgerCurrency('UNKNOWN', settings), 'USD');
  assert.equal(ledgerCurrency('USDT', DEFAULT_SETTINGS), 'USDT');
  assert.equal(ledgerCurrency('CNY', settings), 'CNY');
  for (const trade of trades) { assert.equal(accountOf(trade, settings), 'legacy'); assert.equal(assetTradeCurrency(trade, settings), 'USD'); }
  assert.equal(accountConfig(settings, 'demo-account').capital, 20000);
  const all = multiAssetSummary(trades, settings, { ...range, instrument: 'all' });
  assert.equal(all.netPnl, 110); assert.equal(all.currencyBuckets.length, 1); assert.equal(all.accountCurves.length, 1);
  assert.equal(all.accountSummary.initialCapital, 20000); assert.equal(all.accountSummary.capitalCount, 1); assert.equal(all.accountSummary.realizedEquity, 20110);
  assert.equal(all.accountSummary.maxDrawdown, 40); assert.ok(Math.abs(all.accountSummary.maxDrawdownPct - 40 / 20100 * 100) < 1e-10);
  const filtered = multiAssetSummary(trades, settings, { ...range, instrument: 'NQ' });
  assert.equal(filtered.netPnl, -40); assert.equal(filtered.accountCurves[0].capital, null); assert.equal(filtered.maxDrawdownPct, null);
  assert.equal(filtered.accountSummary.realizedEquity, 20110); assert.equal(filtered.accountSummary.netPnl, 110); assert.equal(filtered.accountSummary.points.length, 3);
  assert.equal(JSON.stringify(trades), before);
  const unconfirmed = { ...settings, multiAsset: { unifiedAccount: { ...demoAccount, ledgerUnitCorrection: { ...demoAccount.ledgerUnitCorrection, confirmed: false } } } };
  assert.equal(multiAssetSummary(trades, unconfirmed, range).accountSummary.realizedEquity, null);
});

test('archive and restore remove and restore every cashflow in the one account, including an erroneously named account', () => {
  const archived = trades.map(trade => trade.id === 'nasdaq' ? { ...trade, archived: true } : trade);
  const result = multiAssetSummary(archived, settings, range);
  assert.equal(result.netPnl, 150); assert.equal(result.accountSummary.realizedEquity, 20150); assert.equal(result.tradeCount, 2);
  assert.equal(multiAssetSummary(trades, settings, range).accountSummary.realizedEquity, 20110);
});

test('the read-only review and G1 statistics use full unified account totals and separate instrument contribution while retaining raw labels', () => {
  const before = JSON.stringify(trades);
  const review = buildReviewData({ records: [], trades, images: [], settings }, { scope: 'range', ...range, instrument: 'NQ' }, new Date('2026-10-20T04:00:00Z'));
  assert.equal(review.statistics.account.totalPnl, 110); assert.equal(review.statistics.account.realizedEquity, 20110);
  assert.equal(review.statistics.account.maxDrawdown, 40); assert.equal(review.statistics.unifiedAccount.initialCapital, 20000);
  assert.equal(review.statistics.all.periodRealizedNetPnl, -40); assert.equal(review.statistics.cashflows.periodRealizedNetPnl, -40);
  assert.equal(review.statistics.fees.actualKnownSum, 1);
  assert.equal(review.trades[0].review.accountId, 'legacy'); assert.equal(review.trades[0].review.rawAccountId, 'demo-account');
  assert.equal(review.trades[0].review.currency, 'USD'); assert.equal(review.trades[0].review.rawCurrency, 'UNKNOWN');
  assert.equal(review.trades[0].contract.currency, 'UNKNOWN');
  const g1 = g1Stats(trades, [], settings);
  assert.equal(g1.tradeCount, 3); assert.equal(g1.netPnl, 110); assert.equal(g1.totalR, 1.1); assert.equal(g1.maxAccountDrawdown, 40);
  assert.equal(JSON.stringify(trades), before);
});

test('new risks share the original G1/non-G1 bands and one capital; saved historical risk snapshots remain frozen', () => {
  for (const instrument of ['XAU', 'NQ', 'BTC']) for (const framework of ['G1', 'independent']) {
    const trade = { ...outcome('risk', instrument, 'USD', 'demo-account', '2026-10-20', 0), framework, strategy: framework === 'G1' ? 'G1-L' : 'none', closes: [], status: 'open', quantity: 1, initialRisk: null };
    const risk = vnextRiskAssessment(trade, settings, new Date('2026-10-20T04:00:00Z'));
    assert.equal(risk.normalMin, framework === 'G1' ? 160 : 80); assert.equal(risk.normalMax, framework === 'G1' ? 240 : 120); assert.equal(risk.hardLimit, framework === 'G1' ? 400 : 200);
    assert.equal(risk.riskPct, 100 * risk.totalRisk / 20000);
  }
  const old = { ...trades[1], revision: 2, instrumentRiskSnapshot: { instrument: 'NQ', currency: 'UNKNOWN', normalRisk: 30, riskLimit: 60, capturedAt: '2026-10-18T01:00:00Z', version: 'multi-asset-1' }, initialRisk: 77.12345678 };
  const before = JSON.stringify(old), risk = vnextRiskAssessment(old, settings);
  assert.equal(risk.normalMax, 30); assert.equal(risk.hardLimit, 60); assert.equal(risk.trial.active, null); assert.equal(old.initialRisk, 77.12345678); assert.equal(JSON.stringify(old), before);
});

test('verified product profile exposes known gross stop risk despite unknown remaining costs and never invents fees or slippage', () => {
  const demoPlan = { ...blankTrade('2026-10-20'), instrument: 'NQ', accountId: 'demo-account', symbol: 'QQQUSDT.P', framework: 'independent', strategy: 'none', openedTime: '09:00:00', direction: 'short', entryPrice: 100, quantity: 6, originalStop: 104, currentStop: 104, targetPrice: 91, aggregateEntryFee: 3, initialRisk: null };
  const before = JSON.stringify(demoPlan), risk = vnextRiskAssessment(demoPlan, settings), remaining = riskSnapshot(demoPlan, settings);
  assert.ok(Math.abs(risk.priceRisk - 24) < 1e-8); assert.ok(Math.abs(risk.grossRR - 2.25) < 1e-8); assert.equal(risk.entryFees, 3); assert.equal(risk.totalRisk, null);
  assert.ok(Math.abs(remaining.grossStopRisk - 24) < 1e-8); assert.equal(remaining.hypothesisRisk, null);
  assert.equal(instrumentConfig(settings, 'NQ').symbol, 'QQQUSDT.P'); assert.equal(instrumentConfig(settings, 'NQ').contract.exitFeePerQty, null);
  assert.equal(JSON.stringify(demoPlan), before);
});

test('one account current exposure combines monetary stop risks and saved valid manual quotes, while missing quotes or costs stay unknown', () => {
  const open = (id,instrument,quote) => ({...outcome(id,instrument,'USD','demo-account','2026-10-20',0),closes:[],status:'open',manualQuote:quote?{price:quote,at:'2026-10-20T04:00:00Z',source:'manual'}:null});
  const nq=open('open-nq','NQ',105),btc=open('open-btc','BTC',null),all=[...trades,nq,btc];
  const before=JSON.stringify(all),first=multiAssetSummary(all,settings,{start:range.start,end:'2026-10-20',instrument:'XAU'}).accountSummary;
  assert.equal(first.currentExposure.positionCount,2);assert.equal(first.currentExposure.hypothesisRisk,22);assert.equal(first.currentExposure.grossStopRisk,20);
  assert.equal(first.currentExposure.unrealizedNetPnl,null);assert.equal(first.currentExposure.estimatedEquity,null);assert.deepEqual(first.currentExposure.missingQuoteTradeIds,['open-btc']);
  const quoted={...btc,manualQuote:{price:103,at:'2026-10-20T04:00:00Z',source:'manual'}};
  const complete=multiAssetSummary([...trades,nq,quoted],settings,{...range,end:'2026-10-20'}).accountSummary.currentExposure;
  assert.equal(complete.unrealizedNetPnl,6);assert.equal(complete.unrealizedGrossPnl,8);assert.equal(complete.estimatedEquity,20116);
  const unknownCosts={...quoted,contract:{...quoted.contract,exitFeePerQty:null,slippagePrice:null}};
  const incomplete=multiAssetSummary([...trades,nq,unknownCosts],settings,{...range,end:'2026-10-20'}).accountSummary.currentExposure;
  assert.equal(incomplete.hypothesisRisk,null);assert.equal(incomplete.grossStopRisk,20);assert.equal(incomplete.unrealizedNetPnl,null);assert.equal(incomplete.unrealizedGrossPnl,8);
  assert.equal(JSON.stringify(all),before);
});

const feeCase = () => ({...outcome('fee-cash','NQ','USD','demo-account','2026-10-20',0),quantity:40,entries:[{id:'paid-entry',date:'2026-10-20',time:'09:00:00',quantity:40,price:100,fees:12,feeSource:'actual',inPlan:true,lossAdd:false,rationale:''}],closes:[],status:'open'});
const cashSummary = trade => multiAssetSummary([trade],settings,{start:'2026-10-20',end:'2026-10-20'}).accountSummary;

test('recorded cash balance deducts an open actual entry fee of 12 while realized profit and equity retain their distinct basis', () => {
  const trade={...feeCase(),manualQuote:{price:100,at:'2026-10-20T04:00:00Z',source:'manual'}},before=JSON.stringify(trade),summary=cashSummary(trade);
  assert.equal(summary.netPnl,0);assert.equal(summary.realizedEquity,20000);assert.equal(summary.paidUnallocatedEntryFees,12);assert.equal(summary.recordedCashBalance,19988);
  assert.equal(summary.paidUnallocatedEntryFeeCoverage.knownPositionCount,1);
  // Forty units at unchanged price: remaining entry fee 12 and exit fee 20.
  assert.equal(summary.currentExposure.unrealizedNetPnl,-32);assert.equal(summary.currentExposure.estimatedEquity,19968);
  assert.equal(summary.currentExposure.estimatedEquity,summary.recordedCashBalance+summary.currentExposure.unrealizedGrossPnl-20);
  assert.equal(JSON.stringify(trade),before);
});

test('partial close deducts only actual entry fees not already allocated in the recorded close net', () => {
  const trade=syncStatus({...feeCase(),closes:[{id:'half',date:'2026-10-20',time:'10:00:00',quantity:20,price:101,fees:2,feeSource:'actual',allocatedEntryFee:6,netPnl:12,calculationMode:'reported',reason:''}]}),before=JSON.stringify(trade),summary=cashSummary(trade);
  assert.equal(summary.netPnl,12);assert.equal(summary.realizedEquity,20012);assert.equal(summary.paidUnallocatedEntryFees,6);assert.equal(summary.recordedCashBalance,20006);
  const automatic={...trade,closes:trade.closes.map(close=>({...close,allocatedEntryFee:undefined,calculationMode:'automatic'}))};
  assert.equal(cashSummary(automatic).paidUnallocatedEntryFees,6);
  const unknownAllocation={...trade,closes:trade.closes.map(close=>({...close,allocatedEntryFee:undefined}))};
  assert.equal(cashSummary(unknownAllocation).recordedCashBalance,null);
  assert.deepEqual(cashSummary(unknownAllocation).paidUnallocatedEntryFeeDetails[0].unknownAllocationCloseIds,['half']);
  assert.equal(JSON.stringify(trade),before);
});

test('fully closed reported broker net remains authoritative and does not deduct entry costs again', () => {
  const trade=syncStatus({...feeCase(),entries:feeCase().entries.map(entry=>({...entry,feeSource:'estimated'})),closes:[{id:'final',date:'2026-10-20',time:'10:00:00',quantity:40,price:101,fees:null,netPnl:57.125,calculationMode:'reported',reason:''}]}),before=JSON.stringify(trade),summary=cashSummary(trade);
  assert.equal(summary.netPnl,57.125);assert.equal(summary.realizedEquity,20057.125);assert.equal(summary.paidUnallocatedEntryFees,0);assert.equal(summary.recordedCashBalance,20057.125);
  assert.equal(summary.paidUnallocatedEntryFeeCoverage.positionCount,0);assert.equal(JSON.stringify(trade),before);
});

test('estimated, unspecified or missing open entry fees keep recorded cash balance unknown with explicit coverage', () => {
  for(const patch of [{feeSource:'estimated'},{feeSource:undefined},{feeSource:'actual',fees:null}]){
    const trade={...feeCase(),entries:feeCase().entries.map(entry=>({...entry,...patch}))},summary=cashSummary(trade);
    assert.equal(summary.realizedEquity,20000);assert.equal(summary.paidUnallocatedEntryFees,null);assert.equal(summary.recordedCashBalance,null);
    assert.equal(summary.paidUnallocatedEntryFeeCoverage.knownPositionCount,0);assert.deepEqual(summary.paidUnallocatedEntryFeeCoverage.unknownTradeIds,['fee-cash']);
  }
});
