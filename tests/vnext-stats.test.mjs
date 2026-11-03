import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_SETTINGS as DEFAULT_SETTINGS } from './demo-settings.mjs';
import { blankDay } from '../lib/domain.ts';
import { blankTrade, syncStatus } from '../lib/trading.ts';
import { blankEntrySnapshot } from '../lib/vnext-schema.ts';
import { buildReviewData } from '../lib/review-data.ts';
import { dailySummaryDraft, derivedDaily, entryEvidence, researchDimensions, researchStatistics, riskRuleEvidence } from '../lib/vnext-stats.ts';

const date = '2026-10-14', now = new Date('2026-10-14T04:00:00Z');
const settings = { ...DEFAULT_SETTINGS, start: '2026-10-01', end: '2026-10-31', riskLimit: 400, accountCurrency: 'USD', minTrades: 30 };
const contract = { confirmed: true, usdPerPriceUnit: 1, entryFeePerQty: 1, exitFeePerQty: 1, slippagePrice: 0, quantityStep: 1, currency: 'USD' };
const entry = (id, quantity = 4, day = date, feeSource = 'actual') => ({ id, date: day, time: '09:00:00', quantity, price: 100, fees: quantity, feeSource, rationale: '', inPlan: true, lossAdd: false });
const close = (id, quantity, netPnl, day = date, primaryReason = 'time_end', feeSource = 'actual') => ({ id, date: day, time: '12:00:00', quantity, price: 110, fees: quantity, feeSource, netPnl, reason: '', reasons: [primaryReason], primaryReason });
function trade(id, closes = [], fields = {}) {
  return syncStatus({ ...blankTrade(date), id, openedTime: '09:00:00', framework: 'independent', strategy: 'none', model: 'S2', direction: 'short', entryPrice: 100, quantity: 4, originalStop: 125, currentStop: 125, initialRisk: 100, contract, entries: [entry(id + ':entry')], closes,
    entrySnapshot: { ...blankEntrySnapshot(), capturedAt: '2026-10-14T01:00:00Z', source: 'entry', framework: 'independent', model: 'S2', direction: 'short', structure4H: 'bull', structure1H: 'bear', structure15m: 'bear', regime: 'transition', entryApproach: 'breakout_retest', confirmation: 'confirmed' }, ...fields });
}

test('actual payoff uses completed net amounts; actual slippage is not inferred from the entry budget',()=>{
  const parents=[trade('win',[close('win-close',4,100)],{research:{mae:null,mfe:null,slippageCost:2}}),trade('loss',[close('loss-close',4,-50)],{riskRuleSnapshot:{capturedAt:'2026-10-14T01:00:00Z',source:'entry',ruleCurrency:'USD',slippage:3}})];
  const original=JSON.stringify(parents),result=researchStatistics(parents,settings).overall;
  assert.equal(result.actualPayoff,2);assert.equal(result.avgWinNetPnl,100);assert.equal(result.avgLossNetPnl,-50);assert.equal(result.slippage.averageRecordedCost,2);assert.equal(result.slippage.coverage.known,1);assert.equal(result.slippage.averageEntryBudget,3);assert.equal(result.netPnl,50);assert.equal(JSON.stringify(parents),original);
});

test('formal daily counters replace raw zeros; additions, partial events and current positions stay distinct', () => {
  const t = trade('daily', [close('partial', 1, 20)], { entries: [entry('first', 4), entry('add', 2)], quantity: 6 });
  const raw = { ...blankDay(date), newTrades: 0, openPositions: 0 }, before = JSON.stringify({ raw, t });
  const result = buildReviewData({ records: [raw], trades: [t], images: [], settings }, { scope: 'today' }, now);
  assert.equal(result.records[0].newTrades, 1); assert.equal(result.records[0].openPositions, 1);
  assert.equal(result.records[0].reportedNewTrades, 0); assert.equal(result.records[0].reportedOpenPositions, 0);
  const daily = result.dailySummaries[0];
  assert.equal(daily.newParentTradeCount, 1); assert.equal(daily.entryEventCount, 2); assert.equal(daily.addEntryEventCount, 1);
  assert.equal(daily.partialCloseEventCount, 1); assert.equal(daily.completedParentTradeCount, 0);
  assert.equal(daily.currentPositions.remainingQuantity, 5); assert.equal(daily.realizedNetPnl, 20); assert.equal(daily.completedNetR, null);
  assert.equal(result.statistics.research.overall.sampleCount, 0);
  assert.equal(JSON.stringify({ raw, t }), before);
});

test('daily fee sources never turn estimated or unspecified saved amounts into actual fees', () => {
  const t = trade('fees', [close('estimated-close', 1, 10, date, 'target', 'estimated'), { ...close('unspecified-close', 1, 10), feeSource: undefined }]);
  const daily = derivedDaily([t], date, settings, date);
  assert.equal(daily.fees.actualKnownSum, 4); assert.equal(daily.fees.estimatedKnownSum, 1); assert.equal(daily.fees.unspecifiedKnownSum, 1);
  assert.equal(daily.realizedNetPnl, 20); assert.equal(daily.fees.alreadyIncludedInSavedNetPnl, true);
  const zero = derivedDaily([trade('zero-fees', [], { entries: [{ ...entry('zero'), fees: 0 }] })], date, settings, date);
  assert.equal(zero.fees.actualKnownSum, 0); assert.equal(zero.fees.estimatedKnownSum, null);
});

test('all formal currencies count as real trading activity while financial values stay in account currency', () => {
  const usd = trade('usd', [close('usd-part', 1, 10)]), usdt = trade('usdt', [close('usdt-part', 1, 999)], { contract: { ...contract, currency: 'USDT' } });
  const daily = derivedDaily([usd, usdt], date, settings, date);
  assert.equal(daily.newParentTradeCount, 2); assert.equal(daily.currentPositions.parentTradeCount, 2);
  assert.equal(daily.closeEventCount, 2); assert.equal(daily.realizedNetPnl, 10);
  assert.equal(daily.fees.actualKnownSum, 5); assert.deepEqual(daily.excludedCurrencyTradeIds, ['usdt']);
  assert.equal(daily.countsScope, 'all-settlement-currencies');
});

test('a draft snapshot cannot swallow the first executed snapshot and later observations never replace entry evidence', () => {
  const t = trade('promoted', [close('final', 4, 100)], {
    originalPlan: { capturedAt: '2026-10-13T00:00:00Z', data: { framework: 'pending', entrySnapshot: { ...blankEntrySnapshot(), framework: 'pending', structure4H: 'bear' }, riskRuleSnapshot: { source: null, capturedAt: null, framework: 'pending' } } },
    observations: [{ ...blankEntrySnapshot(), id: 'later', observedAt: '2026-10-14T04:00:00Z', structure4H: 'bear', entryApproach: 'early_lh_hl' }],
    riskRuleSnapshot: { source: 'entry', capturedAt: '2026-10-14T01:00:00Z', framework: 'independent', version: 'VNext-1', effectiveAt: '2026-10-13T05:00:00Z', normalMin: 80, normalMax: 120, hardLimit: 200, approvedInitialRisk: 100 },
  });
  assert.equal(entryEvidence(t).structure4H, 'bull'); assert.equal(riskRuleEvidence(t).hardLimit, 200);
  const dimensions = researchDimensions(t);
  assert.equal(dimensions.framework, 'independent'); assert.equal(dimensions.structure4H, 'bull'); assert.equal(dimensions.entryApproach, 'breakout_retest');
  const review = buildReviewData({ records: [], trades: [t], images: [], settings }, { scope: 'today' }, now);
  assert.equal(review.trades[0].review.classification.framework, 'independent'); assert.equal(review.trades[0].review.rules.originalApprovedRiskBudget.amount, 100);
  assert.equal(review.statistics.research.overall.riskDistribution.bands.normal, 1);
});

test('each complete parent is one sample per cross grouping and the final saved primary exit controls its mechanism', () => {
  const t = trade('split', [{ ...close('part', 1, 20, date, 'target'), time: '10:00:00', reasons: ['target', 'structure_invalid'] }, close('final', 3, 30, date, 'time_end')]);
  const open = trade('unfinished', [close('partial', 1, 90)]);
  const stats = researchStatistics([t, t, open], settings);
  assert.equal(stats.overall.sampleCount, 1); assert.equal(stats.overall.netPnl, 50); assert.equal(stats.overall.netExpectancyR, 0.5);
  for (const family of ['byFrameworkModel', 'byMarketContext', 'byEntryApproach', 'byExitMechanism', 'crossGroups']) assert.equal(stats[family].reduce((sum, group) => sum + group.sampleCount, 0), 1);
  assert.equal(stats.byExitMechanism[0].dimensions.exitMechanism, 'time');
  assert.equal(stats.crossGroups[0].dimensions.structure4H, 'bull'); assert.equal(stats.crossGroups[0].dimensions.model, 'S2');
  assert.equal(stats.overall.averageHoldingMinutes, 180); assert.equal(stats.overall.averageCompleteFees, 8);
  assert.equal(stats.overall.sufficient, false); assert.match(stats.overall.assessment, /样本不足/);
  assert.deepEqual(stats.incompleteParentTradeIds, ['unfinished']);
});

test('unknown old fields remain unknown and missing times, fees, discipline or paths do not become invented observations', () => {
  const t = trade('legacy', [{ ...close('legacy-final', 4, 30), primaryReason: undefined, reasons: undefined, fees: null, time: null }], { framework: undefined, strategy: undefined, entrySnapshot: undefined, openedTime: null, entries: [{ ...entry('old-entry'), time: null, fees: null }], rationale: '非G1，4H多头，已确认', initialRisk: null });
  const dimensions = researchDimensions(t);
  for (const key of ['framework', 'structure4H', 'structure1H', 'structure15m', 'regime', 'entryApproach', 'exitMechanism']) assert.equal(dimensions[key], 'unknown');
  const stats = researchStatistics([t], settings);
  assert.equal(stats.overall.sampleCount, 1); assert.equal(stats.overall.netPnl, 30); assert.equal(stats.overall.knownRCount, 0); assert.equal(stats.overall.netExpectancyR, null);
  assert.equal(stats.overall.averageHoldingMinutes, null); assert.equal(stats.overall.averageCompleteFees, null); assert.equal(stats.overall.disciplineAdherenceRate, null);
  assert.equal(stats.overall.riskDistribution.bands.unknown, 1); assert.deepEqual(stats.overall.maeMfe.observations, []);
});

test('research retains parent net/R and previous high water without regrading old trades under current rules', () => {
  const prior = trade('prior', [close('prior-final', 4, 100, '2026-10-10')], { openedDate: '2026-10-09', entries: [entry('prior-entry', 4, '2026-10-09')] });
  const loss = trade('loss', [close('loss-final', 4, -60)], { psychology: { discipline: 'partial' }, riskRuleSnapshot: { source: 'entry', capturedAt: '2026-10-14T01:00:00Z', normalMin: 80, normalMax: 120, hardLimit: 200 } });
  const before = JSON.stringify([prior, loss]);
  const stats = researchStatistics([prior, loss], { ...settings, riskLimit: 10 }, date, date);
  assert.equal(stats.overall.sampleCount, 1); assert.equal(stats.overall.netExpectancyR, -0.6); assert.equal(stats.overall.maxDrawdown, 60);
  assert.equal(stats.overall.disciplineAdherenceRate, 0); assert.equal(stats.overall.riskDistribution.bands.normal, 1);
  assert.equal(JSON.stringify([prior, loss]), before);
});

test('generated daily draft reports formal activity and leaves blank default subjective values unrecorded', () => {
  const t = trade('draft-source', [], { quantity: 9, entries: [entry('nine', 9)] }), day = blankDay(date);
  const before = JSON.stringify(day), text = dailySummaryDraft([t], day, settings, date);
  assert.match(text, /新开仓1笔/); assert.match(text, /当前保存持仓1笔/); assert.match(text, /剩余数量9/); assert.match(text, /市场自评：未记录/); assert.match(text, /纪律自评：尚未评价/);
  assert.equal(JSON.stringify(day), before);
  const changed = dailySummaryDraft([t], { ...day, quick: { market: 'transition', structures: [], opportunity: null, discipline: 'partial', emotions: [], energy: null, noTrade: false } }, settings, date);
  assert.match(changed, /趋势转换/); assert.match(changed, /部分偏离/);
});
