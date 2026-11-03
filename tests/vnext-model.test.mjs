import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { DEMO_SETTINGS as DEFAULT_SETTINGS } from './demo-settings.mjs';
import { DEFAULT_G1, blankPsychology, psychologySchema } from '../lib/g1-schema.ts';
import { blankTrade, closeSchema, g1Side, lifecycleSchema, totalRealized } from '../lib/trading.ts';
import { saveTrade, storedTrades, historyFor } from '../lib/trade-repository.ts';
import { DEMO_RISK_RULES as DEFAULT_VNEXT_RISK_RULES } from './demo-settings.mjs';
import { blankEntrySnapshot, observationSchema, riskRulesSchema } from '../lib/vnext-schema.ts';
import { captureRiskRuleSnapshot, currentEffectiveRules, vnextFramework, vnextRiskAssessment } from '../lib/vnext.ts';

const now = new Date('2026-10-13T06:00:00Z');
const contract = { confirmed: true, usdPerPriceUnit: 1, entryFeePerQty: 1, exitFeePerQty: 1, slippagePrice: 0, quantityStep: 1, currency: 'USD' };
const settings = { ...DEFAULT_SETTINGS, accountCurrency: 'USD', g1: { ...DEFAULT_G1, effectiveAt: '2026-10-01T00:00:00Z', contract } };
const market = () => ({ ...blankEntrySnapshot(), structure4H: 'bull', structure1H: 'bear', structure15m: 'bear', regime: 'trend_pullback', entryApproach: 'breakout_retest', locations: ['support_to_resistance'], setupStage: 'confirmed', triggerTypes: ['retest_failed'], confirmation: 'confirmed', invalidationType: 'break_lh', invalidationPrice: 4179 });
const base = (id = 'new-trade', fields = {}) => ({ ...blankTrade('2026-10-13'), id, openedTime: '14:00:00', framework: 'independent', strategy: 'none', model: 'S2', direction: 'short', entryPrice: 100, quantity: 4, originalStop: 125, currentStop: 125, initialRisk: 108, contract, entries: [{ id: id + ':entry', date: '2026-10-13', time: '14:00:00', quantity: 4, price: 100, fees: 4, feeSource: 'actual', rationale: '', inPlan: true, lossAdd: false }], entrySnapshot: market(), ...fields });
function isolatedDb() {
  const sql = new DatabaseSync(':memory:');
  for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) sql.exec(readFileSync(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
  const db = { prepare(query) { const statement = sql.prepare(query); let values = []; return { bind(...args) { values = args; return this; }, async first() { return statement.get(...values) ?? null; }, async all() { return { success: true, results: statement.all(...values) }; } }; }, async batch(statements) { sql.exec('BEGIN'); try { const result = []; for (const statement of statements) result.push(await statement.all()); sql.exec('COMMIT'); return result; } catch (error) { sql.exec('ROLLBACK'); throw error; } } };
  return { sql, db };
}

test('new trades start pending while legacy model/text cannot infer the framework', () => {
  const pending = { ...blankTrade('2026-10-13'), model: 'G1', direction: 'short', executionNote: 'G1 非G1 S2' };
  assert.equal(pending.framework, 'pending');
  assert.equal(vnextFramework(pending), 'pending');
  assert.equal(g1Side(pending), null);
  const old = { ...pending, framework: undefined, model: 'S2' };
  assert.equal(vnextFramework(old), 'pending');
  assert.equal(vnextFramework({ ...old, strategy: 'none' }), 'independent');
  assert.equal(vnextFramework({ ...old, strategy: 'G1-S' }), 'G1');
  assert.equal(g1Side({ ...old, framework: 'independent', model: 'G1' }), null);
  assert.equal(g1Side({ ...old, framework: 'G1', model: 'S2' }), 'short');
});

test('G1-S S1 and independent S2 save distinct frameworks and three independent entry structures', async () => {
  const h = isolatedDb();
  try {
    const g1 = await saveTrade(h.db, 'owner', base('G1-S-S1', { framework: 'G1', strategy: 'G1-S', model: 'S1' }), []);
    const other = await saveTrade(h.db, 'owner', base('independent-S2'), []);
    const reloaded = await storedTrades(h.db, 'owner');
    assert.equal(reloaded.length, 2);
    assert.equal(g1.framework, 'G1');
    assert.equal(g1.entrySnapshot.framework, 'G1');
    assert.equal(g1.entrySnapshot.model, 'S1');
    assert.equal(other.framework, 'independent');
    assert.equal(other.entrySnapshot.model, 'S2');
    assert.equal(other.entrySnapshot.structure4H, 'bull');
    assert.equal(other.entrySnapshot.structure1H, 'bear');
    assert.equal(other.entrySnapshot.structure15m, 'bear');
    assert.equal(other.entrySnapshot.source, 'entry');
    assert.ok(other.entrySnapshot.capturedAt);
    assert.equal(lifecycleSchema.safeParse(other).success, true);
  } finally { h.sql.close(); }
});

test('early LH and confirmed retest entries remain distinct immutable facts when later observations change', async () => {
  const h = isolatedDb();
  try {
    const t = await saveTrade(h.db, 'owner', base('early', { entrySnapshot: { ...market(), entryApproach: 'early_lh_hl', triggerTypes: ['lh'], confirmation: 'early', setupStage: 'waiting_trigger' } }), []);
    const confirmed = await saveTrade(h.db, 'owner', base('confirmed'), []);
    assert.notEqual(t.entrySnapshot.entryApproach, confirmed.entrySnapshot.entryApproach);
    assert.notEqual(t.entrySnapshot.confirmation, confirmed.entrySnapshot.confirmation);
    await assert.rejects(saveTrade(h.db, 'owner', { ...t, entrySnapshot: { ...t.entrySnapshot, confirmation: 'confirmed' } }, []), /快照不能覆盖/);
    const observation = observationSchema.parse({ ...market(), id: 'new-observation', observedAt: now.toISOString(), structure15m: 'bull', confirmation: 'confirmed' });
    const updated = await saveTrade(h.db, 'owner', { ...t, observations: [observation], summary: '事后行情转多' }, []);
    assert.equal(updated.entrySnapshot.confirmation, 'early');
    assert.equal(updated.entrySnapshot.structure15m, 'bear');
    assert.equal(updated.observations[0].structure15m, 'bull');
    assert.equal(JSON.stringify(updated.originalPlan), JSON.stringify(t.originalPlan));
    assert((await historyFor(h.db, 'owner', 'trade', t.id)).some(entry => entry.changes.some(change => change.field === 'observations')));
  } finally { h.sql.close(); }
});

test('B risk warns above 120 and under 200, demands reason, and preserves truthful above-hard executions', async () => {
  const t = base('budget', { quantity: 1, entryPrice: 100, originalStop: 250, currentStop: 250, initialRisk: null, entries: [{ ...base().entries[0], quantity: 1, fees: 1 }] });
  const warning = vnextRiskAssessment(t, settings, now);
  assert.equal(warning.totalRisk, 152);
  assert.equal(warning.normalMin, 80);
  assert.equal(warning.normalMax, 120);
  assert.equal(warning.hardLimit, 200);
  assert.equal(warning.overNormal, true);
  assert.equal(warning.overHard, false);
  assert.equal(warning.requiresReason, true);
  assert.equal(warning.planAllowed, false);
  const reason = vnextRiskAssessment({ ...t, overNormalReason: '确认结构回测，批准超过常规区间的例外' }, settings, now);
  assert.equal(reason.planAllowed, true);
  const over = { ...t, quantity: 2, entries: [{ ...t.entries[0], quantity: 2, fees: 2 }], initialRisk: 304 };
  const assessment = vnextRiskAssessment(over, settings, now);
  assert.equal(assessment.overHard, true);
  assert.equal(assessment.riskCompliant, false);
  assert.equal(assessment.planAllowed, false);
  const h = isolatedDb();
  try {
    const saved = await saveTrade(h.db, 'owner', { ...over, riskCompliant: assessment.riskCompliant }, []);
    assert.equal(saved.initialRisk, 304);
    assert.equal(saved.entries[0].price, 100);
    assert.equal(saved.riskCompliant, false);
  } finally { h.sql.close(); }
  assert.equal(vnextRiskAssessment({ ...t, initialRisk: 300, overNormalReason: '人工记录' }, settings, now).overHard, true);
});

test('complete multi-layer risk adds known entry/exit costs and estimated future costs exactly once', () => {
  const t = base('layers', { quantity: 1, initialRisk: null, originalStop: 120, currentStop: 120, contract: { ...contract, slippagePrice: 0.5 }, entries: [{ ...base().entries[0], quantity: 1, fees: 2 }], entryPlan: [{ id: 'l1', quantity: 1, price: 100, stop: 120, trigger: '' }, { id: 'l2', quantity: 1, price: 110, stop: 125, trigger: '' }, { id: 'l3', quantity: 2, price: 105, stop: 125, trigger: '' }], status: 'partial', closes: [{ id: 'partial', date: '2026-10-13', time: '15:00:00', quantity: 0.5, price: 105, fees: 4, otherCosts: 1, netPnl: -3, reason: '', calculationMode: 'reported' }] });
  const before = structuredClone(t);
  const result = vnextRiskAssessment(t, settings, now);
  assert.equal(result.priceRisk, 75);
  assert.equal(result.entryFees, 5);
  assert.equal(result.exitFees, 7.5);
  assert.equal(result.fees, 13.5);
  assert.equal(result.slippage, 2);
  assert.equal(result.totalRisk, 90.5);
  assert.equal(totalRealized(t), -3);
  assert.deepEqual(t, before);
});

test('actual zero costs stay known, missing costs keep risk unknown, and USD limits never apply to USDT', () => {
  const t = base('zero-cost', { initialRisk: null, entries: [{ ...base().entries[0], fees: 0 }], contract: { ...contract, entryFeePerQty: 0, exitFeePerQty: 0, slippagePrice: 0 } });
  assert.equal(vnextRiskAssessment(t, settings, now).totalRisk, 100);
  assert.equal(vnextRiskAssessment({ ...t, entries: [{ ...t.entries[0], fees: null }], contract: { ...t.contract, entryFeePerQty: null } }, settings, now).totalRisk, null);
  const incomplete = vnextRiskAssessment({ ...t, initialRisk: 100, entries: [{ ...t.entries[0], fees: null }], contract: { ...t.contract, entryFeePerQty: null } }, settings, now);
  assert.equal(incomplete.riskCompliant, null);
  assert.equal(incomplete.planAllowed, false);
  const usdt = { ...t, contract: { ...t.contract, currency: 'USDT' } };
  const result = vnextRiskAssessment(usdt, { ...settings, accountCurrency: 'USDT' }, now);
  assert.equal(result.accountCurrencyMismatch, false);
  assert.equal(result.ruleCurrencyMismatch, true);
  assert.equal(result.overNormal, null);
  assert.equal(result.overHard, null);
  assert.equal(result.maximum, null);
  assert.equal(result.riskCompliant, null);
  assert.equal(captureRiskRuleSnapshot(usdt, { ...settings, accountCurrency: 'USDT' }, now), undefined);
});

test('B effective instant is user-adopted, entry-time based, and never inferred for older or undated entries', () => {
  const effective = DEFAULT_VNEXT_RISK_RULES.independent.effectiveAt;
  assert.equal(effective, '2026-10-13T05:00:00Z');
  assert.equal(currentEffectiveRules(settings).G1.effectiveAt, settings.g1.effectiveAt);
  assert.equal(captureRiskRuleSnapshot(base('before', { openedTime: '12:59:59' }), settings, now), undefined);
  assert.equal(captureRiskRuleSnapshot(base('boundary', { openedTime: '13:00:00' }), settings, now).effectiveAt, effective);
  assert.equal(captureRiskRuleSnapshot(base('same-day-unknown', { openedTime: null }), settings, now), undefined);
  assert.equal(captureRiskRuleSnapshot(base('later-date-unknown-time', { openedDate: '2026-10-14', openedTime: null }), settings, now).effectiveAt, effective);
  assert.equal(captureRiskRuleSnapshot(base('historical', { openedDate: '2026-10-12' }), settings, now), undefined);
  assert.equal(captureRiskRuleSnapshot(base('G1-no-effective', { framework: 'G1' }), { ...settings, g1: { ...DEFAULT_G1, contract } }, now), undefined);
});

test('two-week loss-add restriction checks each actual event time without condemning earlier entries', () => {
  const events = ['12:59:59', '13:00:00'].map((time, index) => ({ ...base().entries[0], id: 'e' + index, date: '2026-10-13', time, quantity: 1, fees: 1, lossAdd: true }));
  const after = { ...events[0], id: 'after-trial', date: '2026-10-27', time: '13:00:00' };
  const unknown = { ...events[0], id: 'unknown-clock', time: null };
  const t = base('trial', { entries: [...events, after, unknown], openedTime: '12:59:59' });
  const result = vnextRiskAssessment(t, settings, new Date('2026-11-01T00:00:00Z'));
  assert.equal(result.trial.active, false);
  assert.deepEqual(result.trial.violatingEntryIds, ['e1']);
  assert.deepEqual(result.trial.dateUnknownEntryIds, ['unknown-clock']);
  assert.equal(result.riskCompliant, false);
  const beforeOnly = vnextRiskAssessment({ ...t, entries: [events[0]], quantity: 1, initialRisk: null }, settings, now);
  assert.deepEqual(beforeOnly.trial.violatingEntryIds, []);
});

test('changing mutable framework cannot disable the independent trial or change its frozen risk limits', () => {
  const original = base('frozen-framework');
  const frozen = captureRiskRuleSnapshot(original, settings, now);
  const changed = { ...original, framework: 'G1', strategy: 'G1-S', quantity: 5, riskRuleSnapshot: frozen, overNormalReason: '真实加仓补录', entries: [...original.entries, { ...original.entries[0], id: 'loss-add', time: '16:00:00', quantity: 1, fees: 1, lossAdd: true }] };
  const result = vnextRiskAssessment(changed, settings, now);
  assert.equal(changed.framework, 'G1');
  assert.equal(result.framework, 'independent');
  assert.equal(result.normalMax, 120);
  assert.equal(result.hardLimit, 200);
  assert.equal(result.trial.prohibitsLossAdd, true);
  assert.deepEqual(result.trial.violatingEntryIds, ['loss-add']);
  assert.equal(result.riskCompliant, false);
  assert.equal(original.initialRisk, 108);
  assert.equal(frozen.framework, 'independent');
});

test('older saved independent actual without entry rules displays estimated risk but never adopts new B violations', () => {
  const old = base('older-saved', { revision: 4, openedDate: '2026-10-12', initialRisk: 300, quantity: 9, riskCompliant: true, entries: [{ ...base().entries[0], date: '2026-10-12', quantity: 9, fees: 9, lossAdd: true }] });
  const before = structuredClone(old), result = vnextRiskAssessment(old, settings, now);
  assert.equal(result.totalRisk, 243);
  assert.equal(result.riskSource, 'legacy-no-rule-snapshot');
  assert.equal(result.limitsAreCurrentReferenceOnly, true);
  assert.equal(result.overNormal, null);
  assert.equal(result.overHard, null);
  assert.equal(result.requiresReason, false);
  assert.equal(result.riskCompliant, null);
  assert.equal(result.trial.active, null);
  assert.deepEqual(result.trial.violatingEntryIds, []);
  assert.equal(result.trial.evaluation, 'unknown-no-entry-rule-snapshot');
  assert.deepEqual(old, before);
  assert.equal(old.riskCompliant, true);
});

test('first execution after an editable plan captures current rules despite an existing plan revision', () => {
  const executing = base('first-execution', { revision: 3, recordType: 'executed', initialRisk: null });
  const snapshot = captureRiskRuleSnapshot(executing, settings, now);
  assert.equal(snapshot.framework, 'independent');
  assert.equal(snapshot.approvedInitialRisk, 108);
  assert.equal(snapshot.hardLimit, 200);
  const firstPolicy = vnextRiskAssessment({ ...executing, revision: 0, riskRuleSnapshot: snapshot }, settings, now);
  assert.equal(firstPolicy.overHard, false);
  assert.equal(firstPolicy.riskCompliant, true);
  const editablePlan = vnextRiskAssessment({ ...executing, recordType: 'plan', entries: [], quantity: 4, entryPrice: 100 }, settings, now);
  assert.equal(editablePlan.riskSource, 'current-effective-rules');
  assert.equal(editablePlan.totalRisk, 108);
  assert.equal(editablePlan.planAllowed, true);
});

test('frozen rule and contract snapshots survive future budget changes without changing original risk or R', async () => {
  const h = isolatedDb();
  try {
    const t = base('frozen', { riskRuleSnapshot: captureRiskRuleSnapshot(base('frozen'), settings, now), status: 'closed', closes: [{ id: 'reported', date: '2026-10-14', time: '12:00:00', quantity: 4, price: 75, fees: 4, netPnl: 97, reason: '原券商净值', calculationMode: 'reported' }] });
    const saved = await saveTrade(h.db, 'owner', t, []);
    const before = JSON.stringify(saved.originalPlan);
    const newerRules = structuredClone(DEFAULT_VNEXT_RISK_RULES);
    newerRules.version = 'VNext-2';
    newerRules.independent.normalMax = 160;
    newerRules.independent.hardLimit = 250;
    const assessment = vnextRiskAssessment(saved, { ...settings, riskRules: newerRules }, now);
    assert.equal(assessment.hardLimit, 200);
    assert.equal(assessment.normalMax, 120);
    assert.equal(assessment.ruleVersion, 'VNext-1');
    assert.equal(saved.initialRisk, 108);
    assert.equal(totalRealized(saved) / saved.initialRisk, 97 / 108);
    await assert.rejects(saveTrade(h.db, 'owner', { ...saved, riskRuleSnapshot: { ...saved.riskRuleSnapshot, approvedInitialRisk: 120 } }, []), /风险规则快照不能覆盖/);
    const updated = await saveTrade(h.db, 'owner', { ...saved, summary: '补充复盘' }, []);
    assert.equal(JSON.stringify(updated.originalPlan), before);
    assert.equal(updated.closes[0].netPnl, 97);
    assert.equal(updated.initialRisk, 108);
  } finally { h.sql.close(); }
});

test('historical unknown fields require explicit human-source confirmation and preserve original snapshots', async () => {
  const h = isolatedDb();
  try {
    const old = base('old-unknown', { framework: undefined, strategy: undefined, entrySnapshot: undefined, openedDate: '2026-10-12', entries: [{ ...base().entries[0], date: '2026-10-12' }] });
    const saved = await saveTrade(h.db, 'owner', old, []), original = JSON.stringify(saved.originalPlan);
    const proposal = { ...saved, framework: 'independent', strategy: 'none', entrySnapshot: market() };
    await assert.rejects(saveTrade(h.db, 'owner', proposal, []), /明确确认补录/);
    const supplemented = await saveTrade(h.db, 'owner', { ...proposal, historicalSupplement: { confirmed: true, evidence: 'pre-entry-record', sourceNote: '核对开仓前保存的结构分析截图与非G1记录', fields: ['framework', 'entrySnapshot'], confirmedAt: null } }, []);
    assert.equal(supplemented.entrySnapshot.source, 'user-confirmed-history');
    assert.ok(supplemented.historicalSupplement.confirmedAt);
    assert.equal(JSON.stringify(supplemented.originalPlan), original);
    assert.equal(supplemented.originalPlan.data.framework, null);
    assert.equal(supplemented.initialRisk, saved.initialRisk);
    assert.equal(supplemented.entries[0].price, saved.entries[0].price);
    assert((await historyFor(h.db, 'owner', 'trade', old.id)).some(event => event.changes.some(change => change.field === 'historicalSupplement')));
    const risk = captureRiskRuleSnapshot(base(), settings, now);
    await assert.rejects(saveTrade(h.db, 'owner', { ...supplemented, riskRuleSnapshot: risk, historicalSupplement: { confirmed: true, evidence: 'user-memory', sourceNote: '事后回忆预算', fields: ['riskRuleSnapshot'], confirmedAt: null } }, []), /原始事前记录/);
  } finally { h.sql.close(); }
});

test('multiple exit reasons retain one principal cause, percentage exits preserve the parent and missing psychology stays null', async () => {
  const valid = { id: 'partial', date: '2026-10-13', time: '16:00:00', quantity: 1, price: 90, fees: 1, netPnl: 8, reason: '', reasons: ['time_end', 'support_holds'], primaryReason: 'time_end' };
  assert.equal(closeSchema.safeParse(valid).success, true);
  assert.equal(closeSchema.safeParse({ ...valid, primaryReason: 'hard_stop' }).success, false);
  const psychology = blankPsychology();
  assert.equal(psychology.fomo, null);
  assert.equal(psychology.fear, null);
  assert.equal(psychology.energy, null);
  assert.equal(psychologySchema.safeParse({ ...psychology, emotions: ['calm', 'confident'], externalOpinion: 'viewed_unaffected', discipline: 'partial', deviationReasons: ['early_entry'] }).success, true);
  const h = isolatedDb();
  try {
    const saved = await saveTrade(h.db, 'owner', base('one-parent', { closes: [valid], status: 'partial', psychology }), []);
    assert.equal(saved.quantity - saved.closes[0].quantity, 3);
    assert.equal((saved.quantity - saved.closes[0].quantity) * 0.5, 1.5);
    assert.equal((await storedTrades(h.db, 'owner')).length, 1);
    assert.equal(totalRealized(saved), 8);
    assert.equal(saved.closes[0].primaryReason, 'time_end');
    assert.equal(saved.initialRisk, 108);
  } finally { h.sql.close(); }
  assert.equal(riskRulesSchema.safeParse({ ...DEFAULT_VNEXT_RISK_RULES, independent: { ...DEFAULT_VNEXT_RISK_RULES.independent, normalMax: 210 } }).success, false);
});

test('editable plan becomes executed once: only formal entry snapshots freeze while the original plan remains unchanged', async () => {
  const h = isolatedDb();
  try {
    const plan = { ...blankTrade('2026-10-13'), id: 'plan-to-execution', recordType: 'plan', openedTime: '14:00:00', model: 'S2', direction: 'short', entrySnapshot: { ...market(), capturedAt: now.toISOString(), source: 'entry' } };
    const savedPlan = await saveTrade(h.db, 'owner', plan, []);
    assert.equal(savedPlan.entrySnapshot.capturedAt, null);
    assert.equal(savedPlan.entrySnapshot.source, null);
    assert.equal(savedPlan.originalPlan.data.entrySnapshot.capturedAt, null);
    const original = JSON.stringify(savedPlan.originalPlan);
    const editedPlan = await saveTrade(h.db, 'owner', { ...savedPlan, entrySnapshot: { ...savedPlan.entrySnapshot, structure4H: 'bear' } }, []);
    assert.equal(editedPlan.entrySnapshot.structure4H, 'bear');
    assert.equal(editedPlan.entrySnapshot.capturedAt, null);
    const executing = { ...base(plan.id), originalPlan: editedPlan.originalPlan, revision: editedPlan.revision, recordType: 'executed', entrySnapshot: { ...editedPlan.entrySnapshot, structure4H: 'bear' }, riskRuleSnapshot: captureRiskRuleSnapshot(base(plan.id), settings, now) };
    const formal = await saveTrade(h.db, 'owner', executing, []);
    assert.ok(formal.entrySnapshot.capturedAt);
    assert.equal(formal.entrySnapshot.source, 'entry');
    assert.equal(formal.entrySnapshot.framework, 'independent');
    assert.equal(formal.entrySnapshot.structure4H, 'bear');
    assert.equal(formal.riskRuleSnapshot.hardLimit, 200);
    assert.equal(formal.initialRisk, 108);
    assert.equal(JSON.stringify(formal.originalPlan), original);
    await assert.rejects(saveTrade(h.db, 'owner', { ...formal, entrySnapshot: { ...formal.entrySnapshot, structure4H: 'bull' } }, []), /快照不能覆盖/);
    assert.equal((await storedTrades(h.db, 'owner')).length, 1);
  } finally { h.sql.close(); }
});

test('each successful revision backs up exact prior private JSON; stale writes leave no backup or audit artifact', async () => {
  const h = isolatedDb();
  try {
    const first = await saveTrade(h.db, 'owner', base('revision-backup'), []);
    const firstRaw = h.sql.prepare('SELECT data FROM trade_records WHERE owner_id=? AND id=?').get('owner', first.id).data;
    const second = await saveTrade(h.db, 'owner', { ...first, summary: '第2次复盘' }, []);
    const backup = h.sql.prepare('SELECT data FROM source_backups WHERE owner_id=? AND source_key=?').get('owner', 'trade:' + first.id + ':revision:1');
    assert.equal(backup.data, firstRaw);
    assert.equal(JSON.parse(backup.data).initialRisk, 108);
    assert.equal(JSON.parse(backup.data).entries[0].price, 100);
    assert.equal(h.sql.prepare('SELECT COUNT(*) n FROM source_backups WHERE owner_id=?').get('owner').n, 1);
    await assert.rejects(saveTrade(h.db, 'owner', { ...first, summary: '过期修改' }, []), /更新/);
    assert.equal(h.sql.prepare('SELECT COUNT(*) n FROM source_backups WHERE owner_id=?').get('owner').n, 1);
    const auditCount = (await historyFor(h.db, 'owner', 'trade', first.id)).length;
    const realBatch = h.db.batch;
    h.db.batch = async statements => {
      // Another editor commits after the repository read but before its batch.
      const external = { ...second, revision: second.revision + 1, summary: '另一页面已保存' };
      h.sql.prepare('UPDATE trade_records SET data=?,revision=?,change_id=? WHERE owner_id=? AND id=?').run(JSON.stringify(external), external.revision, 'external-write', 'owner', first.id);
      h.db.batch = realBatch;
      return realBatch(statements);
    };
    await assert.rejects(saveTrade(h.db, 'owner', { ...second, summary: '并发过期修改' }, []), /更新/);
    assert.equal(h.sql.prepare('SELECT COUNT(*) n FROM source_backups WHERE owner_id=?').get('owner').n, 1);
    assert.equal((await historyFor(h.db, 'owner', 'trade', first.id)).length, auditCount);
    const [current] = await storedTrades(h.db, 'owner');
    assert.equal(current.summary, '另一页面已保存');
    assert.equal(current.revision, 3);
    assert.equal((await storedTrades(h.db, 'other-owner')).length, 0);
  } finally { h.sql.close(); }
});
