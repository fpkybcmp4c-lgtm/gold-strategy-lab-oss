import { equitySeries, moneyFormat, todayCN } from './domain.ts';
import type { DailyRecord, Settings } from './domain.ts';
import { inventory } from './g1.ts';
import { ledgerDays } from './ledger.ts';
import { finalDate, hasExecution, isLegacySummary, orderedCloses, totalRealized, tradeCurrency } from './trading.ts';
import type { TradeRecord } from './trading.ts';
import { dailyDisciplineEvidence, tradeDisciplineEvidence } from './discipline-evidence.ts';

type Snapshot = Record<string, unknown>;
const object = (value: unknown): value is Snapshot => !!value && typeof value === 'object' && !Array.isArray(value);
const inRange = (date: string | null | undefined, start: string, end: string) => !!date && date >= start && date <= end;
const knownNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const positive = (value: unknown): value is number => knownNumber(value) && value > 0;
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const frozenEvidence = (value: unknown): value is Snapshot => object(value) && typeof value.capturedAt === 'string' && (value.source === 'entry' || value.source === 'user-confirmed-history');

/** Saved entry evidence only. Changing observations cannot change this grouping. */
export function entryEvidence(trade: TradeRecord): Snapshot | null {
  const original = trade.originalPlan?.data.entrySnapshot;
  const saved = trade.entrySnapshot;
  return frozenEvidence(original) ? original : object(saved) ? saved : null;
}
export function riskRuleEvidence(trade: TradeRecord): Snapshot | null {
  const original = trade.originalPlan?.data.riskRuleSnapshot;
  const saved = trade.riskRuleSnapshot;
  return frozenEvidence(original) ? original : object(saved) ? saved : null;
}
export function savedFramework(trade: TradeRecord): 'G1' | 'independent' | 'unknown' {
  const snapshot = entryEvidence(trade), explicit = snapshot?.framework ?? trade.framework;
  if (explicit === 'G1' || explicit === 'independent') return explicit;
  if (explicit === 'pending') return 'unknown';
  if (trade.strategy === 'G1-L' || trade.strategy === 'G1-S') return 'G1';
  if (trade.strategy === 'none') return 'independent';
  return 'unknown';
}
export const structureNames: Record<string, string> = { bull: '多头 HH/HL', bear: '空头 LH/LL', bull_to_bear: '多转空', bear_to_bull: '空转多', range: '震荡', unknown: '未知' };
export const regimeNames: Record<string, string> = { trend_continuation: '趋势延续', trend_pullback: '趋势回踩', bear_continuation: '下跌中继', bull_continuation: '上涨中继', range: '震荡区间', transition: '趋势转换', repricing: '突破后重新定价', unknown: '未知' };
export const approachNames: Record<string, string> = { early_lh_hl: 'LH/HL提前入场', breakout_direct: '突破直接入场', breakout_retest: '突破回测确认', double_top_bottom: '双顶/双底确认', sweep_reclaim: '扫高/扫低收回', other: '其他', unknown: '未知' };
export const exitNames: Record<string, string> = { fixed_target: '固定止盈', structural: '结构退出', support_resistance: '支撑阻力退出', time: '时间退出', stop: '止损', other: '其他', unknown: '未知' };

/** One complete parent gets one exit group, from its saved final close's primary reason. */
export function exitMechanism(trade: TradeRecord) {
  const reason = orderedCloses(trade).at(-1)?.primaryReason;
  if (reason === 'target') return 'fixed_target';
  if (reason === 'hard_stop') return 'stop';
  if (reason === 'support_holds' || reason === 'resistance_holds') return 'support_resistance';
  if (reason === 'time_end') return 'time';
  if (['structure_invalid', 'reverse_bos', 'reverse_lh_hl', 'trend_change'].includes(reason ?? '')) return 'structural';
  return reason ? 'other' : 'unknown';
}
export function researchDimensions(trade: TradeRecord) {
  const snapshot = entryEvidence(trade), framework = savedFramework(trade);
  const direction = snapshot?.direction === 'long' || snapshot?.direction === 'short' ? snapshot.direction : trade.direction ?? 'unknown';
  const tag = (key: string, names: Record<string, string>) => typeof snapshot?.[key] === 'string' && snapshot[key] in names ? String(snapshot[key]) : 'unknown';
  return {
    framework, frameworkSide: framework === 'G1' ? !snapshot?.framework && !trade.framework && (trade.strategy === 'G1-L' || trade.strategy === 'G1-S') ? trade.strategy : direction === 'long' ? 'G1-L' : direction === 'short' ? 'G1-S' : 'G1-unknown' : framework,
    model: typeof snapshot?.model === 'string' ? snapshot.model : trade.model,
    direction,
    structure4H: tag('structure4H', structureNames), structure1H: tag('structure1H', structureNames), structure15m: tag('structure15m', structureNames),
    regime: tag('regime', regimeNames), entryApproach: tag('entryApproach', approachNames), exitMechanism: exitMechanism(trade),
    confirmation: typeof snapshot?.confirmation === 'string' ? snapshot.confirmation : 'unknown',
    source: snapshot ? 'saved-entry-snapshot' : 'legacy-explicit-fields-only',
  };
}

function formalTrades(trades: TradeRecord[]) {
  const unique = new Map<string, TradeRecord>();
  for (const trade of trades) if (!trade.archived && hasExecution(trade)) {
    const before = unique.get(trade.id);
    if (!before || trade.revision > before.revision) unique.set(trade.id, trade);
  }
  return [...unique.values()];
}
function firstEntry(trade: TradeRecord) {
  return [...(trade.entries ?? [])].sort((a, b) => (a.date + 'T' + (a.time ?? '')).localeCompare(b.date + 'T' + (b.time ?? '')) || a.id.localeCompare(b.id))[0];
}
function firstExecutionDate(trade: TradeRecord) { return firstEntry(trade)?.date ?? trade.openedDate; }
type Fee = { tradeId: string; eventId: string; kind: 'entry' | 'close'; date: string; amount: number | null; source: 'actual' | 'estimated' | 'recorded-unspecified' | 'unknown' };
export function savedFeeEvents(trade: TradeRecord): Fee[] {
  const fee = (kind: 'entry' | 'close', eventId: string, date: string, amount: number | null | undefined, source?: string): Fee => ({ tradeId: trade.id, eventId, kind, date, amount: knownNumber(amount) ? amount : null, source: !knownNumber(amount) ? 'unknown' : source === 'actual' ? 'actual' : source === 'estimated' ? 'estimated' : 'recorded-unspecified' });
  const entries = trade.entries?.length ? trade.entries.map(entry => fee('entry', entry.id, entry.date, entry.fees, entry.feeSource)) : trade.openedDate && !isLegacySummary(trade) ? [fee('entry', trade.id + ':aggregate-entry', trade.openedDate, trade.aggregateEntryFee)] : [];
  return [...entries, ...trade.closes.map(close => fee('close', close.id, close.date, close.fees, close.feeSource))];
}
export function feeTotals(events: Fee[]) {
  const sum = (source: Fee['source']) => { const found = events.filter(event => event.source === source); return found.length ? found.reduce((sum, event) => sum + event.amount!, 0) : null; };
  return { actualKnownSum: sum('actual'), estimatedKnownSum: sum('estimated'), unspecifiedKnownSum: sum('recorded-unspecified'), unknownEventCount: events.filter(event => event.source === 'unknown').length, eventCount: events.length, knownEventCount: events.filter(event => event.amount !== null).length, alreadyIncludedInSavedNetPnl: true };
}

/** Pure formal-ledger projection; raw daily counters and drafts are never inputs. */
export function derivedDaily(trades: TradeRecord[], date: string, settings: Settings, currentDate = todayCN()) {
  const currency = settings.accountCurrency ?? 'USD';
  const all = formalTrades(trades), actual = all.filter(trade => tradeCurrency(trade) === currency);
  const newParents = all.filter(trade => firstExecutionDate(trade) === date);
  const entries = all.flatMap<{ tradeId: string; eventId: string; kind: string; data: unknown }>(trade => {
    const first = firstEntry(trade);
    if (trade.entries?.length) return trade.entries.filter(entry => entry.date === date).map(entry => ({ tradeId: trade.id, eventId: entry.id, kind: entry.id === first?.id ? 'initial-entry' : 'add-entry', data: entry }));
    return trade.openedDate === date && !isLegacySummary(trade) ? [{ tradeId: trade.id, eventId: trade.id + ':aggregate-entry', kind: 'aggregate-entry', data: null }] : [];
  });
  const closes = all.flatMap(trade => trade.closes.filter(close => close.date === date).map(close => ({ tradeId: trade.id, eventId: close.id, currency: tradeCurrency(trade), completedParent: trade.status === 'closed' && orderedCloses(trade).at(-1)?.id === close.id, data: close })));
  const completed = all.filter(trade => trade.status === 'closed' && finalDate(trade) === date);
  const knownR = completed.filter(trade => tradeCurrency(trade) === currency && positive(trade.initialRisk));
  const legacy = actual.filter(trade => isLegacySummary(trade) && trade.legacy!.dailyDate === date);
  const current = all.filter(trade => !isLegacySummary(trade) && trade.status !== 'closed' && (!firstExecutionDate(trade) || firstExecutionDate(trade)! <= currentDate));
  const positions = current.map(trade => ({ tradeId: trade.id, symbol: trade.symbol, currency: tradeCurrency(trade), remainingQuantity: inventory(trade).quantity }));
  const endOfDay = all.filter(trade => !isLegacySummary(trade) && !!firstExecutionDate(trade) && firstExecutionDate(trade)! <= date).map(trade => {
    const knownEntries = trade.entries?.length ? trade.entries.filter(entry => entry.date <= date).reduce((sum, entry) => sum + entry.quantity, 0) : trade.quantity;
    const remaining = knownEntries === null || trade.closes.some(close => close.date <= date && close.quantity === null) ? null : Math.max(0, knownEntries - trade.closes.filter(close => close.date <= date).reduce((sum, close) => sum + close.quantity!, 0));
    return { tradeId: trade.id, remainingQuantity: remaining, knownClosed: !!finalDate(trade) && finalDate(trade)! <= date };
  }).filter(position => position.remainingQuantity === null ? !position.knownClosed : position.remainingQuantity > 1e-8);
  const fees = actual.flatMap(savedFeeEvents).filter(event => event.date === date);
  return {
    date, currency, source: 'formal-parent-trades-and-execution-events', financialCountsDerived: true, countsScope: 'all-settlement-currencies', financialScope: 'account-settlement-currency-only',executionDiscipline:dailyDisciplineEvidence(all,date),
    newParentTradeCount: newParents.length, newParentTradeIds: newParents.map(trade => trade.id), models: [...new Set(newParents.map(trade => researchDimensions(trade).model))],
    entryEventCount: entries.length, addEntryEventCount: entries.filter(event => event.kind === 'add-entry').length,
    closeEventCount: closes.length, partialCloseEventCount: closes.filter(event => !event.completedParent).length,
    completedParentTradeCount: completed.length, completedParentTradeIds: completed.map(trade => trade.id),
    realizedNetPnl: closes.filter(close => close.currency === currency).reduce((sum, close) => sum + close.data.netPnl, 0) + legacy.reduce((sum, trade) => sum + totalRealized(trade), 0),
    completedNetR: knownR.length ? knownR.reduce((sum, trade) => sum + totalRealized(trade) / trade.initialRisk!, 0) : null,
    knownRParentCount: knownR.length,
    currentPositions: { parentTradeCount: current.length, remainingQuantity: positions.some(position => position.remainingQuantity === null) ? null : positions.reduce((sum, position) => sum + position.remainingQuantity!, 0), holdings: positions, asOfDate: currentDate, unknownQuantityTradeIds: positions.filter(position => position.remainingQuantity === null).map(position => position.tradeId) },
    endOfDayPositions: { parentTradeCount: endOfDay.length, holdings: endOfDay },
    fees: { ...feeTotals(fees), events: fees },
    entries, closes, legacySummaryTradeIds: legacy.map(trade => trade.id),
    excludedCurrencyTradeIds: all.filter(trade => tradeCurrency(trade) !== currency).map(trade => trade.id),
  };
}

/** User may review and edit this text; it does not save or invent subjective judgments. */
export function dailySummaryDraft(trades: TradeRecord[], day: DailyRecord, settings: Settings, currentDate = todayCN()) {
  const actual = derivedDaily(trades, day.date, settings, currentDate);
  const markets: Record<string, string> = { up: '上涨趋势', down: '下跌趋势', range: '震荡', transition: '趋势转换', uncertain: '不确定' };
  const disciplines: Record<string, string> = { full: '完全按计划', partial: '部分偏离', broken: '明显违规', noTrade: '无新增交易自评', unrated: '尚未评价' };
  const market = day.quick?.market ? markets[day.quick.market] : '未记录';
  const discipline = day.quick?.discipline ? disciplines[day.quick.discipline] : '尚未评价';
  return `${day.date}正式交易汇总：新开仓${actual.newParentTradeCount}笔，加仓${actual.addEntryEventCount}次，部分平仓${actual.partialCloseEventCount}次，完整平仓${actual.completedParentTradeCount}笔；当日已实现净损益${moneyFormat(actual.realizedNetPnl, 2)} ${actual.currency}。${actual.models.length ? '新增交易模型为' + actual.models.join('/') + '。' : ''}当前保存持仓${actual.currentPositions.parentTradeCount}笔${actual.currentPositions.remainingQuantity === null ? '，剩余数量部分未记录' : '，已知剩余数量' + moneyFormat(actual.currentPositions.remainingQuantity, 4)}。当前市场自评：${market}；纪律自评：${discipline}。`;
}

function durationMinutes(trade: TradeRecord) {
  const first = firstEntry(trade), last = orderedCloses(trade).at(-1);
  const startDate = first?.date ?? trade.openedDate, startTime = first ? first.time : trade.openedTime;
  if (!startDate || !startTime || !last?.date || !last.time || isLegacySummary(trade)) return null;
  const minutes = (Date.parse(last.date + 'T' + last.time + '+08:00') - Date.parse(startDate + 'T' + startTime + '+08:00')) / 60000;
  return Number.isFinite(minutes) && minutes >= 0 ? minutes : null;
}
function completeFees(trade: TradeRecord) {
  const events = savedFeeEvents(trade);
  if (!events.length || isLegacySummary(trade) || !events.some(event => event.kind === 'entry') || events.some(event => event.amount === null)) return null;
  return events.reduce((sum, event) => sum + event.amount!, 0) + trade.closes.reduce((sum, close) => sum + (close.otherCosts ?? 0), 0);
}
function recordedDiscipline(trade: TradeRecord) {
  if(tradeDisciplineEvidence(trade).length)return false;
  const discipline = trade.psychology?.discipline;
  return discipline === 'full' ? true : discipline === 'partial' || discipline === 'violated' ? false : null;
}
function riskBand(trade: TradeRecord) {
  const rule = riskRuleEvidence(trade);
  if (!positive(trade.initialRisk) || !rule || !positive(rule.normalMin) || !positive(rule.normalMax) || !positive(rule.hardLimit)) return 'unknown';
  if (typeof rule.ruleCurrency === 'string' && rule.ruleCurrency !== tradeCurrency(trade)) return 'unknown';
  return trade.initialRisk > rule.hardLimit ? 'above-hard-limit' : trade.initialRisk > rule.normalMax ? 'above-normal' : trade.initialRisk < rule.normalMin ? 'below-normal' : 'normal';
}
type Dimensions = ReturnType<typeof researchDimensions>;
type DimensionKey = 'frameworkSide' | 'model' | 'structure4H' | 'structure1H' | 'structure15m' | 'regime' | 'entryApproach' | 'exitMechanism';
function researchSample(sample: TradeRecord[], history: TradeRecord[], settings: Settings, start: string, end: string) {
  const knownR = sample.filter(trade => positive(trade.initialRisk)), rs = knownR.map(trade => totalRealized(trade) / trade.initialRisk!);
  const wins = knownR.filter(trade => totalRealized(trade) > 0), losses = knownR.filter(trade => totalRealized(trade) < 0);
  const grossProfit = sample.reduce((sum, trade) => sum + Math.max(0, totalRealized(trade)), 0), grossLoss = sample.reduce((sum, trade) => sum + Math.max(0, -totalRealized(trade)), 0);
  const winAmounts=sample.map(totalRealized).filter(value=>value>0),lossAmounts=sample.map(totalRealized).filter(value=>value<0),avgWinNetPnl=mean(winAmounts),avgLossNetPnl=mean(lossAmounts);
  const actualSlippage=sample.map(trade=>trade.research?.slippageCost).filter((value):value is number=>knownNumber(value));
  const budgetSlippage=sample.map(riskRuleEvidence).filter(rule=>rule?.ruleCurrency=== (settings.accountCurrency??'USD')).map(rule=>rule?.slippage).filter((value):value is number=>knownNumber(value));
  const durations = sample.map(durationMinutes).filter((value): value is number => value !== null);
  const fees = sample.map(completeFees).filter((value): value is number => value !== null);
  const disciplines = sample.map(recordedDiscipline).filter((value): value is boolean => value !== null);
  const risks = knownR.map(trade => trade.initialRisk!).sort((a, b) => a - b);
  const points = equitySeries(ledgerDays([], history, settings.accountCurrency ?? 'USD'), settings).filter(point => inRange(point.date, start, end));
  const enough = sample.length >= settings.minTrades && knownR.length >= settings.minTrades;
  const sources = feeTotals(sample.flatMap(savedFeeEvents));
  const bandKeys = ['below-normal', 'normal', 'above-normal', 'above-hard-limit', 'unknown'];
  return {
    sampleCount: sample.length, parentTradeIds: sample.map(trade => trade.id), completedParentsOnly: true, currency: settings.accountCurrency ?? 'USD',
    winRate: sample.length ? 100 * sample.filter(trade => totalRealized(trade) > 0).length / sample.length : null,
    avgWinR: mean(wins.map(trade => totalRealized(trade) / trade.initialRisk!)), avgLossR: mean(losses.map(trade => totalRealized(trade) / trade.initialRisk!)),
    avgWinNetPnl,avgLossNetPnl,actualPayoff:avgWinNetPnl!==null&&avgLossNetPnl!==null?avgWinNetPnl/Math.abs(avgLossNetPnl):null,actualPayoffBasis:'average-winning-complete-parent-net-over-absolute-average-losing-net',
    averageNetR: mean(rs), netExpectancyR: mean(rs), totalNetR: rs.length ? rs.reduce((sum, value) => sum + value, 0) : null, knownRCount: knownR.length,
    netPnl: sample.reduce((sum, trade) => sum + totalRealized(trade), 0),
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null, profitFactorState: grossLoss > 0 ? 'finite' : grossProfit > 0 ? 'unbounded-no-losses' : 'no-sample',
    maxDrawdown: Math.max(0, ...points.map(point => point.drawdown)), maxDrawdownPct: Math.max(0, ...points.map(point => point.drawdownPct)), drawdownBasis: 'saved-cashflows-of-completed-parents-with-prior-history',
    averageHoldingMinutes: mean(durations), durationCoverage: { known: durations.length, total: sample.length, unknownIsNotMidnight: true },
    averageCompleteFees: mean(fees), completeFeeCoverage: { known: fees.length, total: sample.length }, fees: { ...sources, includeSavedOtherCostsInCompleteAverage: true, noSecondDeductionFromNetPnl: true },
    slippage:{averageRecordedCost:mean(actualSlippage),totalRecordedCost:actualSlippage.length?actualSlippage.reduce((sum,value)=>sum+value,0):null,coverage:{known:actualSlippage.length,total:sample.length},averageEntryBudget:mean(budgetSlippage),budgetCoverage:budgetSlippage.length,source:'explicit-saved-manual-costs; estimated-entry-budget-kept-separate',inferredFromEntryExit:false,noSecondDeductionFromNetPnl:true},
    disciplineAdherenceRate: disciplines.length ? 100 * disciplines.filter(Boolean).length / disciplines.length : null, disciplineCoverage: { known: disciplines.length, total: sample.length, source: 'saved-trade-discipline-self-assessment', currentRulesNotAppliedRetroactively: true },
    riskDistribution: { known: risks.length, total: sample.length, min: risks[0] ?? null, max: risks.at(-1) ?? null, average: mean(risks), median: risks.length ? (risks[Math.floor((risks.length - 1) / 2)] + risks[Math.floor(risks.length / 2)]) / 2 : null, bands: Object.fromEntries(bandKeys.map(band => [band, sample.filter(trade => riskBand(trade) === band).length])), basis: 'saved-initialRisk-and-entry-risk-rule-snapshot' },
    maeMfe: { source: 'explicit-manual-records-only', observations: sample.filter(trade => trade.research?.mae?.source === 'manual' || trade.research?.mfe?.source === 'manual').map(trade => ({ tradeId: trade.id, mae: trade.research?.mae ?? null, mfe: trade.research?.mfe ?? null })), inferredFromEntryExit: false },
    requiredSample: settings.minTrades, sufficient: enough, assessment: enough ? '达到参考样本数，仍不能据此证明稳定优势。' : '样本不足，不能判定统计优势。',
  };
}

/** Every grouping family assigns each complete parent exactly once. */
export function researchStatistics(trades: TradeRecord[], settings: Settings, start = settings.start, end = settings.end) {
  const all = formalTrades(trades), currency = settings.accountCurrency ?? 'USD';
  const history = all.filter(trade => trade.status === 'closed' && tradeCurrency(trade) === currency && !!finalDate(trade) && finalDate(trade)! <= end);
  const completed = history.filter(trade => inRange(finalDate(trade), start, end));
  const group = (fields: DimensionKey[]) => {
    const keys = new Map<string, { dimensions: Partial<Dimensions>; sample: TradeRecord[] }>();
    for (const trade of completed) {
      const dims = researchDimensions(trade), dimensions = Object.fromEntries(fields.map(field => [field, dims[field]])) as Partial<Dimensions>, key = JSON.stringify(dimensions);
      const before = keys.get(key); if (before) before.sample.push(trade); else keys.set(key, { dimensions, sample: [trade] });
    }
    return [...keys.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ key, dimensions: value.dimensions, ...researchSample(value.sample, history.filter(trade => { const dims = researchDimensions(trade); return fields.every(field => dims[field] === value.dimensions[field]); }), settings, start, end) }));
  };
  return {
    schemaVersion: '2.0.0', range: { start, end }, overall: researchSample(completed, history, settings, start, end),
    byFrameworkModel: group(['frameworkSide', 'model']),
    byMarketContext: group(['frameworkSide', 'model', 'structure4H', 'structure1H', 'structure15m', 'regime']),
    byEntryApproach: group(['frameworkSide', 'model', 'entryApproach']),
    byExitMechanism: group(['frameworkSide', 'model', 'exitMechanism']),
    crossGroups: group(['frameworkSide', 'model', 'structure4H', 'structure1H', 'structure15m', 'regime', 'entryApproach', 'exitMechanism']),
    incompleteParentTradeIds: all.filter(trade => trade.status !== 'closed').map(trade => trade.id),
    excludedCurrencyTradeIds: all.filter(trade => tradeCurrency(trade) !== currency).map(trade => trade.id),
    unknownEntrySnapshotTradeIds: completed.filter(trade => !entryEvidence(trade)).map(trade => trade.id),
    groupingBasis: { entry: 'saved-entry-snapshot-only', observationsDoNotRewriteEntry: true, exit: 'final-close-primary-reason', multiReasonsDoNotDuplicateParents: true, partialClosesAreNotSamples: true },
  };
}
