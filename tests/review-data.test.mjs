import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_SETTINGS as DEFAULT_SETTINGS } from './demo-settings.mjs';
import { blankDay } from '../lib/domain.ts';
import { blankG1, CHECK_IDS } from '../lib/g1-schema.ts';
import { blankTrade, lifecycleSchema, syncStatus } from '../lib/trading.ts';
import { buildReviewData, reviewRange } from '../lib/review-data.ts';

const now = new Date('2026-10-12T08:00:00.000Z');
const settings = { ...DEFAULT_SETTINGS, start: '2026-10-01', end: '2027-01-09', accountCurrency: 'USD' };
const contract = { confirmed: true, usdPerPriceUnit: 1, entryFeePerQty: 1, exitFeePerQty: 1, slippagePrice: 0, quantityStep: 1, currency: 'USD' };
const entry = (id, quantity, price, date = '2026-10-11', time = '09:00:00') => ({ id, quantity, price, date, time, fees: quantity, feeSource: 'actual', rationale: '实际成交', inPlan: true, lossAdd: false });
const close = (id, quantity, netPnl, date, time = '12:00:00') => ({ id, quantity, price: 110, date, time, fees: quantity, feeSource: 'actual', netPnl, reason: '已报告的费用后净值', calculationMode: 'reported' });
function trade(id, closes = [], fields = {}) {
  return syncStatus({ ...blankTrade('2026-10-11'), framework: undefined, id, openedTime: '09:00:00', strategy: 'none', model: 'L1', direction: 'long', entryPrice: 100, quantity: 4, entries: [entry(id + ':entry', 4, 100)], originalStop: 75, currentStop: 75, initialRisk: 100, contract, closes, ...fields });
}
const input = (trades = [], fields = {}) => ({ records: [], trades, images: [], settings, ...fields });
const review = (trades = [], fields = {}, query = { scope: 'today' }) => buildReviewData(input(trades, fields), query, now);
const row = (result, strategy) => result.statistics.byStrategy.find(group => group.key === strategy);

test('instrument filters retain historical gold defaults while all-instrument money uses safe multi-asset metrics', () => {
  const oldGold = trade('historical-gold', [close('g', 4, 40, '2026-10-12')]);
  delete oldGold.instrument;
  const nq = trade('nq', [close('n', 4, 120, '2026-10-12')], { instrument: 'NQ', accountId: 'futures', researchModel: 'Opening range', environment: 'trend', executionMode: 'retest', strategy: 'none', model: 'G1' });
  const btc = trade('btc', [close('b', 4, -5, '2026-10-12')], { instrument: 'BTC', accountId: 'crypto', researchModel: 'Breakout', contract: { ...contract, currency: 'USDT' } });
  const snapshot = structuredClone([oldGold, nq, btc]);
  const golden = review(snapshot);
  assert.deepEqual(golden.trades.map(t => t.id), ['historical-gold']);
  assert.equal(golden.statistics.account.totalPnl, 40);
  assert.equal(golden.statistics.legacyStatisticsScope.accountId, 'legacy');
  const all = review(snapshot, {}, { scope: 'today', instrument: 'all' });
  assert.equal(all.trades.length, 3);
  assert.equal(all.statistics.legacyStatisticsScope.available, false);
  assert.equal(all.statistics.account.totalPnl, null);
  assert.equal(all.statistics.account.maxDrawdown, null);
  assert.equal(all.statistics.cashflows.periodRealizedNetPnl, null);
  assert.equal(all.statistics.multiAsset.netPnl, null);
  assert.equal(all.statistics.multiAsset.conversionComplete, false);
  assert.deepEqual(all.statistics.multiAsset.currencyBuckets.map(bucket => [bucket.currency, bucket.netPnl]), [['USD', 160], ['USDT', -5]]);
  assert.equal(all.statistics.multiAsset.accountCurves.length, 3);
  assert.equal(all.statistics.multiAsset.maxDrawdown, null);
  assert.equal(all.trades.find(t => t.id === 'nq').review.classification.model, 'G1');
  assert.equal(all.trades.find(t => t.id === 'nq').researchModel, 'Opening range');
  assert.equal(all.trades.find(t => t.id === 'nq').review.classification.framework, 'independent');
  assert.equal(all.trades.find(t => t.id === 'nq').review.rules.status, 'unknown');
  assert.deepEqual(snapshot, [oldGold, nq, btc]);
});

test('owner-local account filters apply to events, positions and screenshots; contract quantities are never added', () => {
  const gold = trade('gold-position');
  const nq = trade('nq-position', [], { instrument: 'NQ', accountId: 'futures', researchModel: 'Open', quantity: 2, entries: [entry('nq-entry', 2, 100)], instrumentRiskSnapshot: { instrument: 'NQ', currency: 'USD', normalRisk: 50, riskLimit: 100, capturedAt: '2026-10-11T01:00:00Z', version: 'multi-asset-1' } });
  const image = t => ({ id: t.id + ':image', tradeId: t.id, fileName: 'private.png', mime: 'image/png', size: 10, timeframe: '1小时', stage: '持仓过程', caption: '', createdAt: now.toISOString(), updatedAt: now.toISOString() });
  const all = review([gold, nq], { images: [image(gold), image(nq)] }, { scope: 'positions', instrument: 'all' });
  assert.equal(all.dailySummaries[0].currentPositions.remainingQuantity, null);
  assert.deepEqual(all.dailySummaries[0].currentPositions.holdings.map(t => [t.instrument, t.remainingQuantity]), [['XAU', 4], ['NQ', 2]]);
  const selected = review([gold, nq], { images: [image(gold), image(nq)] }, { scope: 'positions', instrument: 'all', accountId: 'futures' });
  assert.deepEqual(selected.trades.map(t => t.id), ['nq-position']);
  assert.deepEqual(selected.currentPositions.map(t => t.tradeId), ['nq-position']);
  assert.deepEqual(selected.screenshots.map(t => t.id), ['nq-position:image']);
  assert.equal(selected.currentPositions[0].risk.ready, true);
  assert.equal(selected.currentPositions[0].risk.overHard, null);
  assert.equal(selected.trades[0].review.rules.source, 'instrument-risk-snapshot');
  const missing = review([gold, nq], { images: [image(gold), image(nq)] }, { scope: 'positions', instrument: 'all', accountId: 'not-saved' });
  assert.equal(missing.trades.length, 0);
  assert.equal(missing.currentPositions.length, 0);
  assert.equal(missing.screenshots.length, 0);
});

test('review query validates instrument and account filter values before data projection', () => {
  for (const instrument of ['GOLD', '', null, 2]) assert.throws(() => reviewRange({ scope: 'today', instrument }, now), /品种/);
  for (const accountId of ['', ' ', 'a\u0000b', 3, null, 'a'.repeat(201)]) assert.throws(() => reviewRange({ scope: 'today', accountId }, now), /账户/);
  assert.equal(reviewRange({ scope: 'today', instrument: 'BTC', accountId: '本人 期货账户' }, now).start, '2026-10-12');
});

test('filtering an archived or reassigned legacy summary never resurrects its old daily source', () => {
  const daily = { ...blankDay('2026-10-12'), trades: [{ id: 'old', model: 'S1', netPnl: 33, initialRisk: 100, inPlan: true }] };
  const original = review([], { records: [daily] }).trades[0];
  const archived = { ...original, archived: true };
  assert.equal(review([archived], { records: [daily] }).statistics.account.totalPnl, 0);
  assert.equal(review([archived], { records: [daily] }).trades.length, 0);
  const reassigned = { ...original, accountId: 'another-gold-account' };
  const selected = review([reassigned], { records: [daily] }, { scope: 'today', instrument: 'XAU', accountId: 'legacy' });
  assert.deepEqual(selected.trades, []);
  assert.equal(selected.statistics.account.totalPnl, 0);
  assert.equal(selected.records[0].trades.length, 0);
});

test('Beijing midnight changes today at 16:00 UTC; default range includes seven calendar dates', () => {
  assert.equal(reviewRange({ scope: 'today' }, new Date('2026-10-11T15:59:59.999Z')).start, '2026-10-11');
  assert.equal(reviewRange({ scope: 'today' }, new Date('2026-10-11T16:00:00.000Z')).start, '2026-10-12');
  const r = reviewRange({ scope: 'range' }, now);
  assert.equal(r.start, '2026-10-06');
  assert.equal(r.end, '2026-10-12');
  assert.equal(reviewRange({ scope: 'range', end: '2026-10-10' }, now).start, '2026-10-04');
  assert.throws(() => reviewRange({ scope: 'range', start: '2026-02-30' }, now), /日期/);
  assert.throws(() => reviewRange({ scope: 'range', start: '2026-10-13', end: '2026-10-12' }, now), /日期/);
  assert.throws(() => reviewRange({ scope: 'range', start: '2020-01-01', end: '2026-10-12' }, now), /分段/);
});

test('partial close on one day is cashflow; full parent R is counted only once on the final day', () => {
  const t = trade('cross-day', [close('c1', 1, 25, '2026-10-12'), close('c2', 3, 75, '2026-10-13')]);
  const partial = review([t]);
  assert.equal(partial.trades.length, 1);
  assert.equal(partial.trades[0].closes.length, 2);
  assert.equal(partial.events.length, 1);
  assert.equal(partial.statistics.cashflows.periodRealizedNetPnl, 25);
  assert.equal(partial.statistics.cashflows.partialCloseNetPnl, 25);
  assert.equal(partial.statistics.all.completedTradeCount, 0);
  assert.equal(partial.statistics.all.totalR, null);
  assert.equal(partial.trades[0].review.completedInRange, false);
  const final = review([t], {}, { scope: 'range', start: '2026-10-13', end: '2026-10-13' });
  assert.equal(final.statistics.all.completedTradeCount, 1);
  assert.equal(final.statistics.all.periodRealizedNetPnl, 75);
  assert.equal(final.statistics.all.completedTradeNetPnl, 100);
  assert.equal(final.statistics.all.totalR, 1);
  assert.equal(final.statistics.all.averageR, 1);
  assert.deepEqual(final.statistics.all.completedTradeIds, ['cross-day']);
  assert.equal(final.trades[0].entries.length, 1);
});

test('three partial execution events never become three completed trade samples', () => {
  const t = trade('one-hypothesis', [close('a', 1, 20, '2026-10-12', '10:00:00'), close('b', 1, -10, '2026-10-12', '11:00:00'), close('c', 2, 40, '2026-10-12', '12:00:00')]);
  const r = review([t]);
  assert.equal(r.statistics.all.parentTradeCount, 1);
  assert.equal(r.statistics.all.completedTradeCount, 1);
  assert.equal(r.statistics.all.closeEventCount, 3);
  assert.equal(r.statistics.all.partialCloseEventCount, 2);
  assert.equal(r.statistics.all.totalR, 0.5);
  assert.equal(r.statistics.cashflows.partialCloseNetPnl, 10);
  assert.equal(r.statistics.cashflows.finalCloseNetPnl, 40);
  assert.equal(r.statistics.account.trades, 1);
  assert.equal(r.statistics.account.totalPnl, 50);
});

test('empty saved data reports no records and no statistical sample without creating blank daily records', () => {
  const r = review();
  assert.deepEqual(r.records, []);
  assert.deepEqual(r.trades, []);
  assert.deepEqual(r.events, []);
  assert.deepEqual(r.currentPositions, []);
  assert.equal(r.missingData.noNewRecords, true);
  assert.match(r.missingData.message, /没有正式/);
  assert.equal(r.statistics.all.winRate, null);
  assert.equal(r.statistics.all.rCoverage, null);
  assert.equal(r.statistics.all.totalR, null);
  assert.equal(r.statistics.all.sufficient, false);
  assert.equal(r.statistics.discipline.violationCount, null);
  assert.equal(r.missingData.sampleInsufficient, true);
  assert.deepEqual(r.missingData.unrecordedDailyDates, ['2026-10-12']);
});

test('missing initial risk excludes only R, preserving actual net PnL and reporting R coverage', () => {
  const known = trade('known-risk', [close('k', 4, 100, '2026-10-12')]);
  const unknown = trade('missing-risk', [close('u', 4, -40, '2026-10-12')], { initialRisk: null });
  const r = review([known, unknown]);
  assert.equal(r.statistics.all.completedTradeCount, 2);
  assert.equal(r.statistics.all.periodRealizedNetPnl, 60);
  assert.equal(r.statistics.all.completedTradeNetPnl, 60);
  assert.equal(r.statistics.all.winRate, 50);
  assert.equal(r.statistics.all.knownR, 1);
  assert.equal(r.statistics.all.rCoverage, 0.5);
  assert.equal(r.statistics.all.totalR, 1);
  assert.equal(r.statistics.all.averageR, 1);
  assert.deepEqual(r.missingData.completedRiskMissingTradeIds, ['missing-risk']);
  assert.equal(r.statistics.all.knownPlanSample, 1);
  assert.match(r.statistics.all.sampleAssessment, /样本不足/);
});

test('legacy summary remains one sample with unknown executions, direction, strategy and rules', () => {
  const daily = { ...blankDay('2026-10-12'), trades: [{ id: 'old', model: 'S1', netPnl: 33, initialRisk: 100, inPlan: true }] };
  const r = review([], { records: [daily] });
  assert.equal(r.trades.length, 1);
  assert.equal(r.events[0].kind, 'legacy-summary');
  assert.equal(r.trades[0].openedDate, null);
  assert.deepEqual(r.trades[0].closes, []);
  assert.equal(r.trades[0].review.classification.strategy, 'unknown');
  assert.equal(r.trades[0].review.rules.status, 'unknown');
  assert.equal(r.statistics.all.completedTradeCount, 1);
  assert.equal(r.statistics.all.totalR, 0.33);
  assert.equal(r.statistics.cashflows.periodRealizedNetPnl, 33);
  assert.equal(row(r, 'S1').parentTradeCount, 0);
  assert.equal(row(r, 'unknown').parentTradeCount, 1);
  const saved = { ...r.trades[0] };
  delete saved.review;
  assert.equal(review([saved], { records: [daily] }).statistics.all.completedTradeCount, 1);
});

test('explicit strategies separate G1 long/short and independent models; missing tags stay unknown', () => {
  const t = trade('base', [close('final', 4, 40, '2026-10-12')]);
  const list = [
    { ...t, id: 'g1-long', strategy: 'G1-L', model: 'L1', direction: 'long', environment: '明确上涨' },
    { ...t, id: 'g1-short', strategy: 'G1-S', model: 'S1', direction: 'short', environment: '明确下跌' },
    { ...t, id: 'independent', strategy: 'none', model: 'S1', direction: 'short' },
    { ...t, id: 'unknown-model', strategy: undefined, model: 'S1', g1: blankG1() },
    { ...t, id: 'legacy-g1-tag', strategy: undefined, model: 'G1', direction: 'short' },
  ];
  const r = review(list);
  assert.equal(row(r, 'G1-L').parentTradeCount, 1);
  assert.equal(row(r, 'G1-S').parentTradeCount, 1);
  assert.equal(row(r, 'S1').parentTradeCount, 1);
  assert.equal(row(r, 'unknown').parentTradeCount, 2);
  assert.equal(r.statistics.byModel.find(group => group.key === 'S1').parentTradeCount, 3);
  assert.equal(r.statistics.byDirection.find(group => group.key === 'short').parentTradeCount, 3);
  assert.equal(r.statistics.byEnvironment.find(group => group.key === '明确上涨').parentTradeCount, 1);
  assert.deepEqual(new Set(r.missingData.unknownStrategyTradeIds), new Set(['unknown-model', 'legacy-g1-tag']));
  for (const id of r.missingData.unknownStrategyTradeIds) assert.equal(r.trades.find(t => t.id === id).review.rules.retrospectiveCompliance, 'unknown');
});

test('A400/B200 context never rewrites historical risk, saved rules, reported net, or entry snapshots', () => {
  const g1 = { ...blankG1(), ruleVersion: 2, effectiveAt: '2026-10-01T00:00:00+08:00', riskBudget: 240, resistanceType: 'A', resistanceLow: 90, resistanceHigh: 100, marketState: 'trend', triggerClass: 'confirmed', checks: Object.fromEntries(CHECK_IDS.map(id => [id, true])) };
  const t = trade('historical', [close('result', 4, 123.45, '2026-10-12')], { initialRisk: 369, strategy: 'G1-L', g1, originalPlan: { capturedAt: '2026-10-11T01:00:00Z', data: { initialRisk: 369, g1 } } });
  const before = structuredClone(t);
  const r = review([t], { settings: { ...settings, riskLimit: 200 } });
  assert.deepEqual(t, before);
  assert.equal(r.trades[0].initialRisk, 369);
  assert.equal(r.trades[0].review.originalInitialRisk, 369);
  assert.equal(r.trades[0].review.rules.snapshot.riskBudget, 240);
  assert.equal(r.trades[0].review.rules.version, 2);
  assert.equal(r.trades[0].review.rules.originalApprovedRiskBudget.amount, 240);
  assert.equal(r.trades[0].review.rules.retrospectiveCompliance, 'unknown');
  assert.equal(r.statistics.all.totalR, 123.45 / 369);
  assert.equal(r.statistics.all.periodRealizedNetPnl, 123.45);
  assert.equal(r.context.referenceRiskBudgets.A, 400);
  assert.equal(r.context.referenceRiskBudgets.B, 200);
  assert.equal(r.context.referenceRiskBudgets.appliesRetroactively, false);
  assert.deepEqual(r.trades[0].originalPlan, before.originalPlan);
});

test('actual, estimated and unlabelled stored fees remain distinct and are never deducted twice', () => {
  const t = trade('fees', [close('actual', 1, 20, '2026-10-12', '10:00:00'), { ...close('estimated', 1, 20, '2026-10-12', '11:00:00'), feeSource: 'estimated', costsEstimated: true }, { ...close('unspecified', 1, 20, '2026-10-12', '12:00:00'), feeSource: undefined }, { ...close('missing', 1, 20, '2026-10-12', '13:00:00'), fees: null, feeSource: undefined }]);
  const r = review([t]);
  assert.equal(r.statistics.cashflows.periodRealizedNetPnl, 80);
  assert.equal(r.statistics.fees.actualKnownSum, 1);
  assert.equal(r.statistics.fees.estimatedSum, 1);
  assert.equal(r.statistics.fees.unspecifiedRecordedSum, 1);
  assert.equal(r.statistics.fees.unknownCount, 1);
  assert.deepEqual(r.trades[0].review.closes.map(c => c.feeSource), ['actual', 'estimated', 'recorded-unspecified', 'unknown']);
  assert.equal(r.trades[0].review.closes[1].costsEstimated, true);
  assert.equal(r.statistics.cashflows.feesAlreadyIncludedInSavedNetPnl, true);
});

test('current positions preserve interleaved inventory and manual quote provenance without adding unrealized profit', () => {
  const t = trade('inventory', [close('early-close', 2, 16, '2026-10-11'), close('later-close', 1, 8, '2026-10-12')], { entries: [entry('e1', 4, 100), entry('e2', 2, 110, '2026-10-12')], manualQuote: { price: 115, at: '2026-10-12T08:00:00Z', source: 'manual' } });
  const daily = { ...blankDay('2026-10-12'), trades: [{ id: 'legacy-closed', model: 'L1', netPnl: 999, initialRisk: 100, inPlan: true }] };
  const r = review([t], { records: [daily] }, { scope: 'positions' });
  assert.equal(r.currentPositions.length, 1);
  assert.equal(r.currentPositions[0].inventory.quantity, 3);
  assert.equal(r.currentPositions[0].inventory.price, 105);
  assert.equal(r.currentPositions[0].unrealizedPnlSource, 'manual-quote-estimate');
  assert.equal(r.currentPositions[0].unrealizedExcludedFromStatistics, true);
  assert.equal(r.statistics.all.periodRealizedNetPnl, 8);
  assert.equal(r.statistics.account.totalPnl, 1007);
  assert.equal(r.statistics.scopes.all, 'current-position-parents-only');
  assert.equal(r.statistics.scopes.account, 'all-saved-formal-trades-and-daily-records');
  assert.equal(r.statistics.account.trades, 1);
  assert.equal(r.statistics.all.completedTradeCount, 0);
  assert.equal(r.statistics.all.totalR, null);
  assert.equal(r.trades[0].entries.length, 2);
  assert.equal(r.currentPositions[0].parentTrade.closes.length, 2);
});

test('drafts and plan-only trades cannot create realized samples or private screenshot references', () => {
  const draft = { ...blankDay('2026-10-12'), isDraft: true, trades: [{ id: 'draft-income', model: 'S1', netPnl: 1000, initialRisk: 100, inPlan: true }] };
  const planned = { ...trade('plan'), recordType: 'plan', entries: [], closes: [] };
  const image = { id: 'draft-image', tradeId: 'daily:2026-10-12', entityType: 'daily', dailyDate: '2026-10-12', fileName: 'private.png', mime: 'image/png', size: 123, timeframe: '1小时', stage: '每日市场观察', caption: '', createdAt: now.toISOString(), updatedAt: now.toISOString() };
  const r = review([planned], { records: [draft], images: [image] });
  assert.deepEqual(r.records, []);
  assert.deepEqual(r.trades, []);
  assert.deepEqual(r.screenshots, []);
  assert.equal(r.statistics.all.periodRealizedNetPnl, 0);
  assert.equal(r.statistics.all.completedTradeCount, 0);
});

test('screenshot output contains only owner-authorized image paths and metadata, never object storage keys', () => {
  const t = trade('image-parent');
  const image = { id: 'private id/1', tradeId: t.id, fileName: 'private.png', mime: 'image/png', size: 123, timeframe: '1小时', stage: '持仓过程', caption: '记录', createdAt: now.toISOString(), updatedAt: now.toISOString(), object_key: 'screenshots/owner-secret/key.png', publicUrl: 'https://storage.example/private' };
  const r = review([t], { images: [image] });
  assert.equal(r.screenshots[0].privatePath, '/api/images?id=private%20id%2F1');
  assert.equal(r.screenshots[0].requiresOwnerAuthorization, true);
  assert.equal(r.screenshots[0].imageContentInspected, false);
  assert.equal(r.trades[0].review.screenshots[0].id, image.id);
  assert.equal(JSON.stringify(r).includes('owner-secret'), false);
  assert.equal(JSON.stringify(r).includes('storage.example'), false);
});

test('different settlement currencies remain separate; account totals never silently convert USDT', () => {
  const usd = trade('usd', [close('usd-close', 4, 40, '2026-10-12')]);
  const usdt = { ...usd, id: 'usdt', contract: { ...contract, currency: 'USDT' } };
  const r = review([usd, usdt]);
  assert.equal(r.trades.length, 2);
  assert.equal(r.statistics.all.completedTradeCount, 1);
  assert.equal(r.statistics.cashflows.periodRealizedNetPnl, 40);
  assert.equal(r.statistics.account.totalPnl, 40);
  assert.deepEqual(r.statistics.excludedCurrencyTradeIds, ['usdt']);
});

test('data versions are stable across query time and input order, change on corrections, and honor database version metadata', () => {
  const first = trade('first', [close('first-close', 4, 40, '2026-10-12')]);
  const second = trade('second');
  const day = { ...blankDay('2026-10-12'), note: '原始备注' };
  const a = input([first, second], { records: [day] });
  const base = buildReviewData(a, { scope: 'today' }, now);
  const later = buildReviewData(input([second, first], { records: [day] }), { scope: 'range' }, new Date('2026-10-12T09:00:00Z'));
  assert.equal(base.dataVersion, later.dataVersion);
  assert.notEqual(base.generatedAt, later.generatedAt);
  assert.notEqual(base.dataVersion, review([{ ...first, closes: [{ ...first.closes[0], netPnl: 41 }] }, second], { records: [day] }).dataVersion);
  assert.notEqual(base.dataVersion, review([first, second], { records: [{ ...day, note: '更正备注' }] }).dataVersion);
  assert.notEqual(base.dataVersion, review([first, second], { records: [day], settings: { ...settings, minTrades: 31 } }).dataVersion);
  const supplied = review([first], { dataVersion: 'sha256:loader-version', lastUpdatedAt: '2026-10-12T07:59:00Z', metadata: { snapshotRead: 'single-batch' } });
  assert.equal(supplied.dataVersion, 'sha256:loader-version');
  assert.equal(supplied.lastUpdatedAt, '2026-10-12T07:59:00Z');
  assert.equal(supplied.metadata.snapshotRead, 'single-batch');
});

test('G1 overall and framework models retain winning/losing R while independent S1 stays separate', () => {
  const win = trade('g1-win', [close('w', 4, 200, '2026-10-12')], { strategy: 'G1-L', model: 'S1' });
  const loss = trade('g1-loss', [close('l', 4, -50, '2026-10-12')], { strategy: 'G1-S', model: 'S1', direction: 'short' });
  const separate = trade('independent-s1', [close('i', 4, 999, '2026-10-12')], { strategy: 'none', model: 'S1' });
  const r = review([win, loss, separate]);
  const g1 = r.statistics.byFramework.find(group => group.key === 'G1');
  assert.equal(g1.parentTradeCount, 2);
  assert.equal(g1.avgWinR, 2);
  assert.equal(g1.avgLossR, -0.5);
  assert.equal(g1.netExpectancyR, 0.75);
  assert.equal(g1.payoff, 4);
  assert.equal(r.statistics.byFrameworkModel.find(group => group.key === 'G1:S1').completedTradeCount, 2);
  assert.equal(r.statistics.byFrameworkModel.find(group => group.key === 'independent:S1').completedTradeCount, 1);
  assert.equal(row(r, 'S1').completedTradeNetPnl, 999);
});

test('strategy drawdown uses prior realized high water and daily violations are counted only at account level', () => {
  const prior = trade('prior-profit', [close('prior', 4, 100, '2026-10-10')], { openedDate: '2026-10-09', entries: [entry('prior-entry', 4, 100, '2026-10-09')], strategy: 'G1-L' });
  const loss = trade('today-loss', [close('loss', 4, -60, '2026-10-12')], { strategy: 'G1-L' });
  const independent = trade('separate-position');
  const daily = { ...blankDay('2026-10-12'), violations: 2, impulses: 1, planCompliant: false };
  const r = review([prior, loss, independent], { records: [daily] });
  const group = row(r, 'G1-L');
  assert.deepEqual(group.tradeIds, ['today-loss']);
  assert.equal(group.maxDrawdown, 60);
  assert.equal(group.maxDrawdownPct, 100 * 60 / 20100);
  assert.equal(group.drawdownBasis.retainsPriorPeriodHistory, true);
  assert.equal(r.statistics.discipline.violationCount, 2);
  assert.equal(r.statistics.discipline.adherenceRate, 0);
  assert.deepEqual(r.statistics.discipline.sourceDates, ['2026-10-12']);
  assert.equal(r.statistics.discipline.attributedToStrategy, false);
  assert.equal(group.discipline.violationCount, null);
  assert.equal(row(r, 'L1').discipline.violationCount, null);
  assert.equal(group.discipline.adherenceRate, null);
});

test('no new trade is independent of existing daily records or close events; unrecorded approval budget is unknown', () => {
  const old = trade('old-parent', [close('old-close', 1, 10, '2026-10-12')]);
  const r = review([old], { records: [blankDay('2026-10-12')] });
  assert.equal(r.missingData.noNewRecords, false);
  assert.equal(r.missingData.noNewTrades, true);
  assert.equal(r.statistics.activity.newParentTradeCount, 0);
  assert.equal(r.statistics.activity.openEventCount, 0);
  assert.equal(r.trades[0].review.rules.originalApprovedRiskBudget.amount, null);
  assert.equal(r.trades[0].review.rules.originalApprovedRiskBudget.status, 'unknown');
  assert.deepEqual(r.missingData.originalApprovedRiskBudgetUnknownTradeIds, ['old-parent']);
  assert.deepEqual(r.context.referenceRiskBudgets.normalA, { min: 160, max: 240 });
  assert.deepEqual(r.context.referenceRiskBudgets.normalB, { min: 80, max: 120 });
  assert.equal(r.context.referenceRiskBudgets.trialB.durationDays, 14);
  assert.equal(r.context.referenceRiskBudgets.trialB.prohibitsAddingToLosingPosition, true);
  assert.equal(r.context.referenceRiskBudgets.trialB.effectiveAt, '2026-10-13T05:00:00Z');
});

test('detailed legacy with unknown opening date includes its real close in parent details and every net/R view', () => {
  const t = {
    ...blankTrade('2026-10-11'), id: 'legacy:2026-10-11:old-detailed', openedDate: null, openedTime: null,
    model: 'S1', initialRisk: 100, status: 'closed',
    legacy: { dailyDate: '2026-10-11', tradeId: 'old-detailed', netPnl: 33, detailed: true },
    closes: [{ id: 'recorded-final-close', date: '2026-10-12', time: null, quantity: null, price: null, fees: null, netPnl: 33, reason: '补全真实平仓净值，开仓日期未记录' }],
  };
  assert.equal(lifecycleSchema.safeParse(t).success, true);
  const before = structuredClone(t);
  const r = review([t]);
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].openedDate, null);
  assert.equal(r.trades[0].openedTime, null);
  assert.equal(r.trades[0].review.legacySummary, false);
  assert.equal(r.trades[0].review.openingDateKnown, false);
  assert.equal(r.trades[0].closes[0].id, 'recorded-final-close');
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].kind, 'close');
  assert.equal(r.statistics.account.totalPnl, 33);
  assert.equal(r.statistics.cashflows.periodRealizedNetPnl, 33);
  assert.equal(r.statistics.all.periodRealizedNetPnl, 33);
  assert.equal(r.statistics.all.completedTradeNetPnl, 33);
  assert.equal(r.statistics.all.totalR, 0.33);
  assert.equal(r.statistics.all.completedTradeCount, 1);
  assert.deepEqual(r.missingData.unknownOpeningDateTradeIds, [t.id]);
  assert.deepEqual(t, before);
  const byRange = review([t], {}, { scope: 'range', start: '2026-10-12', end: '2026-10-12' });
  assert.equal(byRange.trades.length, 1);
  assert.equal(byRange.statistics.cashflows.periodRealizedNetPnl, byRange.statistics.account.totalPnl);
});

test('restored current position without opening metadata keeps actual partial cashflow and marks unknown remaining risk', () => {
  const t = {
    ...blankTrade('2026-10-11'), id: 'restored-undated-partial', openedDate: null, openedTime: null,
    initialRisk: null, status: 'partial',
    closes: [{ id: 'known-partial-close', date: '2026-10-12', time: null, quantity: null, price: null, fees: null, netPnl: 10, reason: '保存的真实部分平仓，其他字段未知' }],
  };
  const future = trade('future-position', [], { openedDate: '2026-10-13', entries: [entry('future-entry', 4, 100, '2026-10-13')] });
  const before = structuredClone(t);
  const r = review([t, future], {}, { scope: 'positions' });
  assert.equal(r.currentPositions.length, 1);
  const position = r.currentPositions[0];
  assert.equal(position.tradeId, t.id);
  assert.equal(position.openedDate, null);
  assert.equal(position.openingDateKnown, false);
  assert.equal(position.positionPresenceBasis, 'saved-current-status');
  assert.equal(position.inventory.quantity, null);
  assert.equal(position.remainingQuantityKnown, false);
  assert.equal(position.risk.hypothesisRisk, null);
  assert.equal(position.parentTrade.openedDate, null);
  assert.equal(r.trades[0].closes[0].id, 'known-partial-close');
  assert.equal(r.statistics.account.totalPnl, 10);
  assert.equal(r.statistics.cashflows.periodRealizedNetPnl, 10);
  assert.equal(r.statistics.all.periodRealizedNetPnl, 10);
  assert.equal(r.statistics.all.totalR, null);
  assert.deepEqual(r.missingData.currentPositionOpeningDateUnknownTradeIds, [t.id]);
  assert.deepEqual(r.missingData.currentPositionRemainingQuantityUnknownTradeIds, [t.id]);
  assert.deepEqual(t, before);
  const today = review([t]);
  assert.equal(today.trades.length, 1);
  assert.equal(today.events[0].kind, 'close');
  assert.equal(today.statistics.cashflows.periodRealizedNetPnl, today.statistics.account.totalPnl);
});
