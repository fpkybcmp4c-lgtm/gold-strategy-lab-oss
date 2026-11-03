import test from 'node:test';
import assert from 'node:assert/strict';
import { blankTrade } from '../lib/trading.ts';
import { DEMO_SETTINGS as DEFAULT_SETTINGS } from './demo-settings.mjs';
import { DEFAULT_UNIFIED_ACCOUNT, multiAssetSummary } from '../lib/multi-asset.ts';

test('half-cent amounts are identical for selected and full-account sums across synthetic event permutations', () => {
  const date = '2026-10-20';
  const legacy = (id, netPnl) => ({ ...blankTrade(date), id, openedDate: null, framework: undefined, initialRisk: 1, status: 'closed', legacy: { dailyDate: date, tradeId: id, netPnl } });
  const trades = [legacy('synthetic-one', 100), legacy('synthetic-two', -110), legacy('synthetic-three', -0.005)];
  const before = JSON.stringify(trades), settings = { ...DEFAULT_SETTINGS, multiAsset: { unifiedAccount: structuredClone(DEFAULT_UNIFIED_ACCOUNT) } };
  const permutations = values => values.length ? values.flatMap((value, index) => permutations(values.filter((_, other) => index !== other)).map(rest => [value, ...rest])) : [[]];
  const orderings = permutations(trades);
  const displayed = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const naiveDisplays = new Set(orderings.map(ordering => displayed.format(ordering.reduce((sum, trade) => sum + trade.legacy.netPnl, 0))));
  assert.deepEqual([...naiveDisplays].sort(), ['-10.00', '-10.01'], 'The fixture reproduces the original floating-point half-cent split');
  for (const ordering of orderings) {
    const summary = multiAssetSummary(ordering, settings, { instrument: 'all', start: date, end: date });
    assert.equal(summary.netPnl, -10.005);
    assert.equal(summary.accountSummary.netPnl, summary.netPnl);
    assert.equal(summary.accountSummary.cumulativeNetPnl, summary.netPnl);
    assert.equal(displayed.format(summary.netPnl), '-10.01');
    assert.equal(displayed.format(summary.accountSummary.cumulativeNetPnl), displayed.format(summary.netPnl));
  }
  assert.equal(JSON.stringify(trades), before, 'Original amounts, saved initial risks, R inputs, fees and all raw JSON remain unchanged');
});

test('derived money is stabilized after summing, retaining sub-cent contributions from individual events', () => {
  const date = '2026-10-20';
  const legacy = (id, netPnl) => ({ ...blankTrade(date), id, openedDate: null, framework: undefined, initialRisk: 1, status: 'closed', legacy: { dailyDate: date, tradeId: id, netPnl } });
  const trades = [legacy('fraction-one', 0.000000004), legacy('fraction-two', 0.000000004)];
  const before = JSON.stringify(trades), settings = { ...DEFAULT_SETTINGS, multiAsset: { unifiedAccount: structuredClone(DEFAULT_UNIFIED_ACCOUNT) } };
  for (const ordering of [trades, [...trades].reverse()]) {
    const summary = multiAssetSummary(ordering, settings, { instrument: 'all', start: date, end: date });
    assert.equal(summary.netPnl, 0.00000001);
    assert.equal(summary.accountSummary.cumulativeNetPnl, 0.00000001);
  }
  assert.equal(JSON.stringify(trades), before);
});
