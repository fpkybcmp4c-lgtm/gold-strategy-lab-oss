import test from 'node:test';
import assert from 'node:assert/strict';
import { apiHarness } from './api-harness.mjs';
import { DEMO_SETTINGS as DEFAULT_SETTINGS } from './demo-settings.mjs';
import { DEFAULT_G1, blankG1, CHECK_IDS } from '../lib/g1-schema.ts';
import { blankTrade, g1Side, lifecycleSchema, orderedCloses, syncStatus } from '../lib/trading.ts';
import { inventory, riskSnapshot } from '../lib/g1.ts';
import { saveSettings } from '../lib/repository.ts';
import { vnextRiskAssessment } from '../lib/vnext.ts';
import { buildReviewData } from '../lib/review-data.ts';

const date = '2026-10-20', now = new Date(date + 'T04:00:00Z');
const contract = currency => ({ confirmed: true, currency, settlement: 'linear', feeMode: 'perQuantity', usdPerPriceUnit: 1, entryFeePerQty: 0.5, exitFeePerQty: 0.5, slippagePrice: 0, quantityStep: 0.01 });
const settings = { ...DEFAULT_SETTINGS, start: '2026-10-01', g1: { ...DEFAULT_G1, contract: contract('USD'), effectiveAt: '2026-10-01T00:00:00Z' }, multiAsset: { accounts: [{ id: 'nq', name: '隔离纳指账户', currency: 'USD', capital: 10000 }, { id: 'btc', name: '隔离BTC账户', currency: 'USDT', capital: 5000 }], instruments: { NQ: { contract: contract('USD'), normalRisk: 30, riskLimit: 60 }, BTC: { contract: contract('USDT'), normalRisk: 40, riskLimit: 80 } } } };
function candidate(instrument, framework = 'G1', model = 'L1', direction = 'long', quantity = 1) {
  const currency = instrument === 'BTC' ? 'USDT' : 'USD', stop = direction === 'long' ? 90 : 110;
  return syncStatus({ ...blankTrade(date), instrument, accountId: instrument === 'XAU' ? 'legacy' : instrument.toLowerCase(), symbol: instrument + '-FIXTURE', framework, strategy: framework === 'G1' ? direction === 'long' ? 'G1-L' : 'G1-S' : 'none', model, openedTime: '09:00:00', direction, quantity, entryPrice: 100, originalStop: stop, currentStop: stop, targetPrice: direction === 'long' ? 120 : 80, initialRisk: null, recordType: 'executed', contract: contract(currency), g1: framework === 'G1' ? { ...blankG1(), side: direction, marketState: 'trend', triggerClass: 'confirmed', resistanceType: 'A', resistanceLow: 90, resistanceHigh: 100, checks: Object.fromEntries(CHECK_IDS.map(id => [id, true])) } : undefined, entries: [{ id: crypto.randomUUID(), date, time: '09:00:00', quantity, price: 100, fees: quantity * 0.5, feeSource: 'actual', rationale: '', inPlan: true, lossAdd: false }] });
}
async function put(h, trade) { const response = await h.trades.PUT(h.req('/api/trades', 'PUT', trade)); return { status: response.status, ...await response.json() }; }

test('XAU, NQ and BTC save the same G1/independent frameworks and S1/S2/L1/L2 entry models with their own risk amounts', async () => {
  const h = apiHarness();
  try {
    await saveSettings(h.db, 'A', settings);
    const saved = [];
    for (const instrument of ['XAU', 'NQ', 'BTC']) for (const [framework, model, direction] of [['G1', 'L1', 'long'], ['G1', 'S1', 'short'], ['independent', 'L2', 'long'], ['independent', 'S2', 'short']]) {
      const result = await put(h, candidate(instrument, framework, model, direction));
      assert.equal(result.status, 200, JSON.stringify(result));
      const trade = result.trade; saved.push(trade);
      assert.equal(trade.framework, framework); assert.equal(trade.model, model);
      assert.equal(trade.entrySnapshot.framework, framework); assert.equal(trade.entrySnapshot.model, model);
      assert.equal(trade.riskRuleSnapshot.framework, framework);
      assert.equal(trade.riskRuleSnapshot.ruleCurrency, instrument === 'BTC' ? 'USDT' : 'USD');
      assert.equal(trade.initialRisk, 11); assert.equal(trade.riskCompliant, true);
      assert.equal(g1Side(trade), framework === 'G1' ? direction : null);
      if (instrument !== 'XAU') {
        assert.equal(trade.riskRuleSnapshot.hardLimit, instrument === 'NQ' ? 60 : 80);
        assert.equal(trade.riskRuleSnapshot.normalMax, instrument === 'NQ' ? 30 : 40);
      }
    }
    const payload = buildReviewData({ records: [], trades: saved, images: [], settings }, { scope: 'range', start: date, end: date, instrument: 'all' }, now);
    for (const trade of payload.trades) {
      assert.equal(trade.review.classification.framework, trade.framework);
      assert.equal(trade.review.classification.model, trade.model);
      assert.equal(trade.review.rules.source, 'risk-rule-snapshot');
    }
    assert.equal(h.sql.prepare('SELECT COUNT(*) n FROM trade_records').get().n, 12);
  } finally { h.sql.close(); }
});

test('shared rules enforce confirmation and hard limits for each instrument; NQ/BTC snapshots and initial R stay frozen', async () => {
  const h = apiHarness();
  try {
    await saveSettings(h.db, 'A', settings);
    let result = await put(h, candidate('NQ', 'independent', 'S2', 'short', 3));
    assert.equal(result.status, 400); assert.match(result.error, /常规风险预算/);
    result = await put(h, { ...candidate('NQ', 'independent', 'S2', 'short', 3), overNormalReason: '核对本品种预算后确认' });
    assert.equal(result.status, 200, result.error);
    for (const instrument of ['XAU', 'NQ', 'BTC']) {
      const hard = await put(h, candidate(instrument, 'independent', 'S2', 'short', 20));
      assert.equal(hard.status, 200, hard.error); assert.equal(hard.trade.riskCompliant, false);
      const plan = { ...candidate(instrument, 'G1', 'L1', 'long', 50), recordType: 'plan', entries: [] };
      assert.equal((await put(h, plan)).status, 400);
      const lossAdd = candidate(instrument, 'independent', 'L2'); lossAdd.entries[0].lossAdd = true;
      const actual = await put(h, lossAdd); assert.equal(actual.status, 200, actual.error); assert.equal(actual.trade.riskCompliant, false);
    }
    let saved = (await put(h, candidate('BTC'))).trade;
    const risk = saved.initialRisk, rules = structuredClone(saved.riskRuleSnapshot), assetRules = structuredClone(saved.instrumentRiskSnapshot), entry = structuredClone(saved.entrySnapshot);
    await saveSettings(h.db, 'A', { ...settings, multiAsset: { ...settings.multiAsset, instruments: { ...settings.multiAsset.instruments, BTC: { ...settings.multiAsset.instruments.BTC, normalRisk: 1, riskLimit: 2 } } } });
    saved = syncStatus({ ...saved, closes: [{ id: 'final', date, time: '11:00:00', quantity: 1, price: 110, fees: 0.5, feeSource: 'actual', netPnl: 0, calculationMode: 'automatic', reason: '' }] });
    result = await put(h, saved); assert.equal(result.status, 200, result.error);
    assert.equal(result.trade.initialRisk, risk); assert.equal(result.trade.closes[0].netPnl, 9);
    assert.deepEqual(result.trade.riskRuleSnapshot, rules); assert.deepEqual(result.trade.instrumentRiskSnapshot, assetRules); assert.deepEqual(result.trade.entrySnapshot, entry);
    assert.equal(result.trade.closes[0].netPnl / result.trade.initialRisk, 9 / 11);
    for (const patch of [{ framework: 'independent', strategy: 'none' }, { riskRuleSnapshot: { ...rules, hardLimit: 9999 } }, { instrumentRiskSnapshot: { ...assetRules, riskLimit: 9999 } }]) assert.equal((await put(h, { ...result.trade, ...patch })).status, 400);
  } finally { h.sql.close(); }
});

test('missing or mismatched native risk limits stay unknown and old asset-only snapshots do not gain retrospective shared rules', () => {
  const missing = { ...settings, multiAsset: { ...settings.multiAsset, instruments: { NQ: { contract: contract('USD') } } } };
  const assessment = vnextRiskAssessment(candidate('NQ'), missing, now);
  assert.equal(assessment.normalMax, null); assert.equal(assessment.hardLimit, null); assert.equal(assessment.overHard, null); assert.equal(assessment.riskCompliant, null);
  const mismatch = candidate('BTC'); mismatch.contract = contract('USD');
  const mixed = vnextRiskAssessment(mismatch, settings, now);
  assert.equal(mixed.currencyMismatch, true); assert.equal(mixed.overHard, null); assert.equal(mixed.riskCompliant, null);
  const old = { ...candidate('NQ', 'independent', 'S1'), revision: 3, initialRisk: 77.12345678, instrumentRiskSnapshot: { instrument: 'NQ', currency: 'USD', normalRisk: null, riskLimit: null, capturedAt: date + 'T03:00:00Z', version: 'multi-asset-1' } };
  old.entries[0].lossAdd = true;
  const before = JSON.stringify(old), prior = vnextRiskAssessment(old, settings, now);
  assert.equal(prior.normalMax, null); assert.equal(prior.hardLimit, null); assert.equal(prior.overHard, null);
  assert.equal(prior.trial.active, null); assert.deepEqual(prior.trial.violatingEntryIds, []);
  assert.equal(prior.riskSource, 'saved-instrument-entry-rules'); assert.equal(JSON.stringify(old), before);
  assert.equal(riskSnapshot(old, settings).overHard, null);
});

test('mixed minute/second precision at the same instant validates and sorts consistently; tiny BTC remains open', () => {
  let trade = candidate('BTC'); trade.entries[0].time = '09:00:00'; trade.openedTime = '09:00:00';
  trade = syncStatus({ ...trade, closes: [{ id: 'at-same-instant', date, time: '09:00', quantity: 1, price: 101, fees: 0.5, netPnl: 0, reason: '' }] });
  assert.equal(lifecycleSchema.safeParse(trade).success, true);
  assert.equal(inventory(trade).quantity, 0);
  assert.deepEqual(orderedCloses({ ...trade, closes: [{ ...trade.closes[0], id: 'b', time: '09:00' }, { ...trade.closes[0], id: 'a', time: '09:00:00' }] }).map(close => close.id), ['a', 'b']);
  const reopened = syncStatus({ ...trade, entries: [{ ...trade.entries[0], fees: null }, { ...trade.entries[0], id: 'reopen', time: '10:00', price: 200, fees: 1 }], closes: trade.closes });
  assert.equal(inventory(reopened).quantity, 1); assert.equal(inventory(reopened).price, 200); assert.equal(inventory(reopened).entryFees, 1);
  const tiny = candidate('BTC', 'G1', 'L1', 'long', 1e-10);
  assert.equal(tiny.status, 'open'); assert.equal(inventory(tiny).price, 100); assert.equal(lifecycleSchema.safeParse(tiny).success, true);
  assert.equal(lifecycleSchema.safeParse({ ...tiny, closes: [{ ...trade.closes[0], quantity: 2e-10 }], status: 'closed' }).success, false);
});
