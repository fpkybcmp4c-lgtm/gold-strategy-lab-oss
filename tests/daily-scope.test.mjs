import { DEMO_SETTINGS } from './demo-settings.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as domain from '../lib/domain.ts';
import * as stats from '../lib/vnext-stats.ts';
import * as assets from '../lib/multi-asset.ts';
import { blankTrade, syncStatus } from '../lib/trading.ts';
import { apiHarness } from './api-harness.mjs';

const date = '2026-10-14';
const settings = { ...DEMO_SETTINGS, accountCurrency: 'USD' };
function fixture(instrument, accountId, currency, quantity, netPnl, fields = {}) {
  const id = instrument + ':' + accountId;
  return syncStatus({ ...blankTrade(date), id, instrument, accountId, symbol: instrument + '-contract', recordType: 'executed', openedTime: '09:00:00', direction: 'long', entryPrice: 100, quantity, originalStop: 90, currentStop: 90, initialRisk: 10, contract: { confirmed: true, usdPerPriceUnit: 1, entryFeePerQty: 1, exitFeePerQty: 1, slippagePrice: 0, quantityStep: 0.01, currency }, entries: [{ id: id + ':entry', date, time: '09:00:00', quantity, price: 100, fees: 1, feeSource: 'actual', inPlan: true, lossAdd: false, rationale: '' }], closes: [{ id: id + ':close', date, time: '10:00:00', quantity: quantity / 2, price: 110, fees: 1, feeSource: 'actual', netPnl, calculationMode: 'reported', reason: '' }], ...fields });
}
const trades = [fixture('XAU', 'legacy', 'USD', 2, 10), fixture('NQ', 'futures', 'USD', 3, 20, { inPlan: false }), fixture('BTC', 'crypto', 'USDT', 0.5, -1), fixture('XAU', 'other-gold', 'USD', 7, 40)];
function quickModule() {
  const source = readFileSync(new URL('../app/quick-checkin.tsx', import.meta.url), 'utf8');
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText, {
    exports: module.exports,
    require(name) {
      if (name === 'react') return React;
      if (name.endsWith('/domain')) return domain;
      if (name.endsWith('/vnext-stats')) return stats;
      if (name.endsWith('/multi-asset')) return assets;
      if (name.endsWith('/wellbeing-fields')) return { BufferedText: 'textarea' };
      throw new Error(name);
    },
  });
  return module.exports;
}

test('daily panel separates instruments and native currencies, keeps old gold account money and shows only per-trade quantities', () => {
  const { DailyAutoSummary, scopedDailySummaryDraft } = quickModule();
  const before = JSON.stringify(trades);
  const html = renderToStaticMarkup(React.createElement(DailyAutoSummary, { trades, date, settings }));
  assert.match(html, /黄金原账户/);
  for (const text of ['黄金', '纳指', 'BTC', '50.00 USD', '20.00 USD', '-1.00 USDT', '10.00 USD', '缺少可靠的当日汇率', '逐笔数量']) assert.ok(html.includes(text), text);
  assert.ok(!html.includes('6.2500'), 'remaining quantities across contracts/accounts cannot be added');
  assert.ok(!html.includes('69.00'), 'USD and USDT cashflows cannot be added without a reliable rate');
  assert.match(html, /全品种交易事件保存了违规证据/);
  const draft = scopedDailySummaryDraft(trades, domain.blankDay(date), settings);
  assert.match(draft, /黄金原账户：.*当日已实现净损益10.00 USD/);
  assert.match(draft, /黄金：50.00 USD；纳指：20.00 USD；BTC：-1.00 USDT/);
  assert.ok(!draft.includes('6.2500'));
  assert.ok(!draft.includes('69.00'));
  assert.match(draft, /全品种已保存纪律证据/);
  assert.equal(JSON.stringify(trades), before);
});

test('records GET retains scoped gold fields and supplies safe multi-asset daily summaries without writes or tenant leakage', async () => {
  const h = apiHarness();
  try {
    for (const [owner, list] of [['A', trades], ['B', [fixture('NQ', 'other-owner-private', 'USD', 99, 999)]]]) for (const trade of list) h.sql.prepare('INSERT INTO trade_records (owner_id,id,data,revision,change_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(owner, trade.id, JSON.stringify(trade), 1, 'fixture', date, date);
    const changes = h.sql.prepare('SELECT total_changes() n').get().n;
    const response = await h.records.GET(h.req('/api/records'));
    assert.equal(response.status, 200);
    const payload = await response.json();
    const old = payload.dailySummaries.find(day => day.date === date), all = payload.multiAssetDailySummaries.find(day => day.date === date);
    assert.deepEqual(old.statisticsScope, { instrument: 'XAU', accountId: 'legacy', currency: 'USD' });
    assert.equal(old.realizedNetPnl, 10);
    assert.equal(old.currentPositions.remainingQuantity, 1);
    assert.equal(old.executionDiscipline.minimumViolations, 1);
    assert.equal(old.executionDisciplineScope, 'owner-global-all-instruments-and-accounts');
    assert.equal(all.netPnl, null);
    assert.deepEqual(all.currencyBuckets.map(bucket => [bucket.currency, bucket.netPnl]), [['USD', 70], ['USDT', -1]]);
    assert.equal(all.currentPositions.remainingQuantity, null);
    assert.deepEqual(all.currentPositions.holdings.map(holding => [holding.instrument, holding.accountId, holding.remainingQuantity]).sort(), [['BTC', 'crypto', 0.25], ['NQ', 'futures', 1.5], ['XAU', 'legacy', 1], ['XAU', 'other-gold', 3.5]]);
    assert.equal(all.maxDrawdown, null);
    assert.ok(!JSON.stringify(payload).includes('other-owner-private'));
    assert.equal(h.sql.prepare('SELECT total_changes() n').get().n, changes);
  } finally { h.sql.close(); }
});
