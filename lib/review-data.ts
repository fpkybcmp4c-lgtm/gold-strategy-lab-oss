import { addDays, dayDistance, equitySeries, summarize } from './domain.ts';
import type { DailyRecord, Settings } from './domain.ts';
import { inventory, permission, riskSnapshot } from './g1.ts';
import { g1PlanSchema } from './g1-schema.ts';
import { ledgerDays } from './ledger.ts';
import { calendarDate, compatibleTrades, finalDate, hasExecution, isLegacySummary, legacyId, orderedCloses, totalRealized, tradeCurrency } from './trading.ts';
import type { TradeImage, TradeRecord } from './trading.ts';
import { derivedDaily, entryEvidence, researchDimensions, researchStatistics, riskRuleEvidence, savedFramework } from './vnext-stats.ts';
import { currentEffectiveRules } from './vnext.ts';
import { accountOf, assetTradeCurrency, conversionRate, instrumentOf, ledgerCurrency, multiAssetSummary, rawTradeCurrency, unifiedAccountConfig } from './multi-asset.ts';
import type { Instrument } from './multi-asset.ts';
import { savedAssetRules } from './asset-policy.ts';

export type ReviewQuery = { scope: 'today' | 'positions' | 'range'; start?: string; end?: string; instrument?: 'all' | Instrument; accountId?: string };
export type ReviewInput = {
  records: DailyRecord[];
  trades: TradeRecord[];
  images: TradeImage[];
  settings: Settings;
  /** The authorized loader can provide its database snapshot SHA-256. */
  dataVersion?: string;
  lastUpdatedAt?: string | null;
  metadata?: Record<string, unknown>;
};
export const REVIEW_TIMEZONE = 'Asia/Shanghai';
export const REVIEW_SCHEMA_VERSION = '2.1.0';
const URL = '/';
const period = (date: string | null | undefined, start: string, end: string) => !!date && date >= start && date <= end;
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const copy = <T>(value: T): T => structuredClone(value);

function cnDate(now: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: REVIEW_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  return ['year', 'month', 'day'].map(name => parts.find(p => p.type === name)!.value).join('-');
}

/** Shared by HTTP and MCP. Dates are inclusive Beijing calendar dates. */
export function reviewRange(query: ReviewQuery, now = new Date()) {
  if (!Number.isFinite(now.getTime())) throw new Error('复盘时间无效。');
  if (!query || !['today', 'positions', 'range'].includes(query.scope)) throw new Error('复盘范围无效。');
  if (query.instrument !== undefined && !['all', 'XAU', 'NQ', 'BTC'].includes(query.instrument)) throw new Error('交易品种必须是 all、XAU、NQ 或 BTC。');
  if (query.accountId !== undefined && (typeof query.accountId !== 'string' || !query.accountId.trim() || query.accountId.length > 200 || /[\u0000-\u001f\u007f]/.test(query.accountId))) throw new Error('交易账户筛选无效；此参数只筛选本人已保存的交易账户。');
  const today = cnDate(now);
  const end = query.scope === 'range' ? query.end ?? today : today;
  const start = query.scope === 'range' ? query.start ?? addDays(end, -6) : today;
  if (!calendarDate.safeParse(start).success || !calendarDate.safeParse(end).success || start > end) throw new Error('开始和结束日期必须是有效的 YYYY-MM-DD，且开始日期不能晚于结束日期。');
  if (dayDistance(start, end) > 366) throw new Error('一次复盘区间不能超过367个日历日，请分段读取。');
  return { scope: query.scope, start, end, today, inclusive: true, timezone: REVIEW_TIMEZONE };
}

// A content version, never an authorization token. The production loader supplies SHA-256.
function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const object = value as Record<string, unknown>;
  return '{' + Object.keys(object).filter(key => object[key] !== undefined).sort().map(key => JSON.stringify(key) + ':' + canonical(object[key])).join(',') + '}';
}
function contentVersion(input: ReviewInput) {
  const value = canonical({ records: [...input.records].sort((a, b) => a.date.localeCompare(b.date)), trades: [...input.trades].sort((a, b) => a.id.localeCompare(b.id)), images: [...input.images].sort((a, b) => a.id.localeCompare(b.id)), settings: input.settings });
  let first = 2166136261, second = 2246822519;
  for (let i = 0; i < value.length; i++) {
    first = Math.imul(first ^ value.charCodeAt(i), 16777619);
    second = Math.imul(second ^ value.charCodeAt(i), 3266489917);
  }
  return 'content-fnv64:' + (first >>> 0).toString(16).padStart(8, '0') + (second >>> 0).toString(16).padStart(8, '0');
}

/** Missing strategy is unknown; saved model or a G1 parameter block cannot establish membership. */
export function reviewClassification(trade: TradeRecord) {
  const explicit = trade.strategy, dimensions = researchDimensions(trade), framework = savedFramework(trade);
  const strategy = framework === 'G1' ? dimensions.frameworkSide : framework === 'independent' ? ['S1', 'S2', 'L1', 'L2'].includes(dimensions.model) ? dimensions.model : 'other-independent' : 'unknown';
  return {
    strategy,
    framework,
    direction: dimensions.direction,
    model: dimensions.model,
    environment: trade.environment?.trim() || trade.g1?.marketState || 'unknown',
    source: entryEvidence(trade)?.framework ? 'saved-entry-snapshot' : trade.framework ? 'saved-framework' : explicit === undefined ? 'missing-strategy' : 'saved-strategy',
    marketStructure: { structure4H: dimensions.structure4H, structure1H: dimensions.structure1H, structure15m: dimensions.structure15m, regime: dimensions.regime },
    entryApproach: dimensions.entryApproach, confirmation: dimensions.confirmation,
  };
}

function recordedRules(trade: TradeRecord) {
  const riskRule = riskRuleEvidence(trade);
  if (riskRule) return {
    status: 'recorded', source: 'risk-rule-snapshot', version: riskRule.version ?? null, effectiveAt: riskRule.effectiveAt ?? null,
    snapshot: copy(riskRule),
    originalApprovedRiskBudget: { amount: positive(riskRule.approvedInitialRisk) ? riskRule.approvedInitialRisk : null, status: positive(riskRule.approvedInitialRisk) ? 'recorded' : 'unknown', source: positive(riskRule.approvedInitialRisk) ? 'riskRuleSnapshot.approvedInitialRisk' : 'unknown' },
    recordedInPlan: trade.inPlan, recordedRiskCompliant: trade.riskCompliant, entryPermission: 'unknown', retrospectiveCompliance: 'unknown',
    explanation: '使用入场时冻结的风险规则和批准风险；当前规则与后续观察不改变历史合规判断或R分母。',
  };
  if (instrumentOf(trade) !== 'XAU' && savedAssetRules(trade)) {
    const saved = savedAssetRules(trade)!;
    return {
      status: 'recorded', source: 'instrument-risk-snapshot', version: saved.version, effectiveAt: saved.capturedAt, snapshot: copy(saved),
      originalApprovedRiskBudget: { amount: null, status: 'unknown', source: 'unknown' }, recordedInPlan: trade.inPlan, recordedRiskCompliant: trade.riskCompliant,
      entryPermission: 'unknown', retrospectiveCompliance: 'unknown', explanation: '保留旧版此品种入场时保存的风险额度；缺少的共享策略与试行期规则快照保持未知，不追溯补写。',
    };
  }
  const original = trade.originalPlan?.data.g1;
  const plan = original && typeof original === 'object' ? original as Record<string, unknown> : trade.g1;
  const parsed = g1PlanSchema.safeParse(plan);
  const known = parsed.success && positive(parsed.data.ruleVersion);
  const approvedRisk = trade.originalPlan?.data.riskBudget;
  const originalBudget = original && typeof original === 'object' ? (original as Record<string, unknown>).riskBudget : null;
  const budget = positive(approvedRisk) ? approvedRisk : positive(originalBudget) ? originalBudget : null;
  return {
    status: known ? 'recorded' : 'unknown',
    source: known ? original ? 'originalPlan' : 'saved-trade' : 'unknown',
    version: known ? plan!.ruleVersion : null,
    effectiveAt: typeof plan?.effectiveAt === 'string' ? plan.effectiveAt : null,
    snapshot: plan ? copy(plan) : null,
    originalApprovedRiskBudget: { amount: budget, status: budget === null ? 'unknown' : 'recorded', source: positive(approvedRisk) ? 'originalPlan.data.riskBudget' : positive(originalBudget) ? 'originalPlan.data.g1.riskBudget' : 'unknown' },
    recordedInPlan: trade.inPlan,
    recordedRiskCompliant: trade.riskCompliant,
    // Stored checks are evidence; current account settings are not retroactive rules.
    entryPermission: known && parsed.success && (trade.strategy === 'G1-L' || trade.strategy === 'G1-S') ? permission(parsed.data) : 'unknown',
    retrospectiveCompliance: 'unknown',
    explanation: '保留已记录检查与风险标记；未用当前设置或新参考预算追溯判定历史违规。',
  };
}

function imageReference(image: TradeImage) {
  return {
    id: image.id, tradeId: image.tradeId, entityType: image.entityType ?? 'trade',
    dailyDate: image.dailyDate ?? null, opportunityId: image.opportunityId ?? null,
    fileName: image.fileName, mime: image.mime, size: image.size, timeframe: image.timeframe,
    stage: image.stage, caption: image.caption, createdAt: image.createdAt, updatedAt: image.updatedAt,
    privatePath: '/api/images?id=' + encodeURIComponent(image.id), requiresOwnerAuthorization: true,
    imageContentIncluded: false, imageContentInspected: false,
  };
}

function feeKind(fee: number | null | undefined, source: 'actual' | 'estimated' | undefined) {
  return fee == null ? 'unknown' : source === 'estimated' ? 'estimated' : source === 'actual' ? 'actual' : 'recorded-unspecified';
}

function tradeView(trade: TradeRecord, images: TradeImage[], start: string, end: string, settings?: Settings) {
  const completeDate = finalDate(trade);
  return {
    ...copy(trade),
    review: {
      instrument: instrumentOf(trade), accountId: accountOf(trade, settings), rawAccountId: trade.accountId ?? null, rawCurrency: settings ? rawTradeCurrency(trade, settings) : tradeCurrency(trade),
      classification: reviewClassification(trade),
      entrySnapshot: entryEvidence(trade) ? copy(entryEvidence(trade)) : null,
      riskRuleSnapshot: riskRuleEvidence(trade) ? copy(riskRuleEvidence(trade)) : null,
      researchDimensions: researchDimensions(trade),
      rules: recordedRules(trade),
      currency: settings ? assetTradeCurrency(trade, settings) : tradeCurrency(trade),
      originalInitialRisk: trade.originalPlan && Object.hasOwn(trade.originalPlan.data, 'initialRisk') ? trade.originalPlan.data.initialRisk : trade.initialRisk,
      savedInitialRisk: trade.initialRisk,
      rDenominator: 'saved-initialRisk',
      lifetimeRealizedNetPnl: totalRealized(trade),
      periodRealizedNetPnl: isLegacySummary(trade) ? period(trade.legacy!.dailyDate, start, end) ? totalRealized(trade) : 0 : trade.closes.filter(close => period(close.date, start, end)).reduce((sum, close) => sum + close.netPnl, 0),
      completedDate: completeDate,
      completedInRange: period(completeDate, start, end),
      openingDateKnown: trade.openedDate !== null,
      rangeMembershipBasis: trade.openedDate === null ? 'saved-status-and-recorded-event-or-legacy-dates-opening-unknown' : 'saved-opening-date-lifecycle',
      completedTradeR: trade.status === 'closed' && positive(trade.initialRisk) ? totalRealized(trade) / trade.initialRisk : null,
      legacySummary: isLegacySummary(trade),
      parentTradePreserved: true,
      entries: (trade.entries ?? []).map(entry => ({ id: entry.id, feeSource: feeKind(entry.fees, entry.feeSource) })),
      closes: trade.closes.map(close => ({ id: close.id, feeSource: feeKind(close.fees, close.feeSource), costsEstimated: close.costsEstimated ?? null, netPnlSource: close.calculationMode ?? 'reported', allocatedEntryFee: close.allocatedEntryFee ?? null, otherCosts: close.otherCosts ?? null })),
      aggregateEntryFeeSource: trade.aggregateEntryFee == null ? 'unknown' : 'recorded-unspecified',
      screenshots: images.filter(image => (image.entityType ?? 'trade') === 'trade' && image.tradeId === trade.id).map(imageReference),
    },
  };
}

/** Keep the original account statistics as an explicitly scoped compatibility view.
 * New multi-asset queries must use currency buckets and separate account curves. */
export function buildReviewData(input: ReviewInput, query: ReviewQuery, now = new Date()) {
  const range = reviewRange(query, now), { start, end, today } = range;
  const instrument = query.instrument ?? 'XAU', accountId = query.accountId ?? 'all', unified = unifiedAccountConfig(input.settings);
  const records = input.records.filter(record => record.isDraft !== true && record.status !== 'draft').sort((a, b) => a.date.localeCompare(b.date));
  const authorizedTrades = compatibleTrades(records, input.trades).filter(trade => !trade.archived && hasExecution(trade));
  const scoped = authorizedTrades.filter(trade => (instrument === 'all' || instrumentOf(trade) === instrument) && (accountId === 'all' || accountOf(trade, input.settings) === accountId || !!unified && trade.accountId === accountId));
  const legacyAvailable = instrument === 'XAU' && (accountId === 'all' || accountId === 'legacy');
  const goldTrades = legacyAvailable ? scoped.filter(trade => instrumentOf(trade) === 'XAU' && accountOf(trade, input.settings) === 'legacy') : [];
  // Daily legacy summaries belong only to the original gold account. Clearing a
  // projection here never changes the stored daily record or historical trade.
  const goldIds = new Set(goldTrades.map(trade => trade.id));
  const goldRecords = records.map(record => ({ ...record, trades: legacyAvailable ? record.trades.filter(trade => goldIds.has(legacyId(record.date, trade.id))) : [] }));
  const base = buildGoldReviewData({ ...input, records: goldRecords, trades: goldTrades }, query, now);
  const current = scoped.filter(trade => !isLegacySummary(trade) && trade.status !== 'closed' && (!trade.openedDate || trade.openedDate <= today));
  const selected = query.scope === 'positions' ? current : scoped.filter(trade => overlapsRange(trade, start, end));
  const periodRecords = records.filter(record => period(record.date, start, end));
  const selectedIds = new Set([...selected, ...current].map(trade => trade.id));
  const images = input.images.filter(image => (image.entityType ?? 'trade') === 'trade' ? selectedIds.has(image.tradeId) : image.entityType === 'daily' && periodRecords.some(record => record.date === image.dailyDate));
  const events = selected.flatMap(trade => tradeEvents(trade, start, end).map(event => ({ ...event, instrument: instrumentOf(trade), accountId: accountOf(trade, input.settings), rawAccountId: trade.accountId ?? null, rawCurrency: rawTradeCurrency(trade,input.settings), currency: assetTradeCurrency(trade, input.settings) }))).sort((a, b) => (a.date + 'T' + (a.time ?? '')).localeCompare(b.date + 'T' + (b.time ?? '')) || a.tradeId.localeCompare(b.tradeId) || a.id.localeCompare(b.id));
  const newTrades = scoped.filter(trade => period(trade.openedDate, start, end));
  const summaryView = (trades: TradeRecord[], first: string, last: string) => {
    const { selected: parents, closed, ...metrics } = multiAssetSummary(trades, input.settings, { instrument, accountId, start: first, end: last });
    return { ...metrics, selectedTradeIds: parents.map(trade => trade.id), completedTradeIds: closed.map(trade => trade.id), source: 'saved-formal-parent-trades-and-realized-close-events', excludesUnrealized: true, moneyAggregation: 'confirmed-date-specific-fx-only', drawdownAggregation: 'separate-account-and-settlement-currency-curves' };
  };
  const multiAsset = summaryView(query.scope === 'positions' ? current : scoped, start, end);
  const sameLegacyScope = !unified && legacyAvailable && scoped.every(trade => instrumentOf(trade) === 'XAU' && accountOf(trade, input.settings) === 'legacy');
  const dailyView = (date: string) => {
    if (sameLegacyScope) return derivedDaily(scoped, date, input.settings, today);
    const original = derivedDaily(scoped, date, input.settings, today), day = summaryView(scoped, date, date);
    const holdings = current.map(trade => ({ tradeId: trade.id, instrument: instrumentOf(trade), accountId: accountOf(trade, input.settings), currency: assetTradeCurrency(trade, input.settings), remainingQuantity: inventory(trade).quantity }));
    return {
      ...original, currency: day.currency, source: 'scoped-formal-parent-trades-and-execution-events', financialScope: 'multiAsset-currency-buckets-and-account-curves',
      realizedNetPnl: day.netPnl, completedNetR: day.totalR, knownRParentCount: day.knownR,
      currentPositions: { ...original.currentPositions, remainingQuantity: null, holdings, quantityAggregation: 'not-combined-across-contracts-or-accounts' },
      // Old fee totals assume one currency. Preserve the dated native amounts
      // while requiring consumers to use their currency labels.
      fees: { ...original.fees, actualKnownSum: null, estimatedKnownSum: null, unspecifiedKnownSum: null, aggregateUnavailable: true, events: scoped.flatMap(trade => [...(trade.entries ?? []).filter(entry => entry.date === date).map(entry => ({ tradeId: trade.id, eventId: entry.id, kind: 'entry', date, amount: entry.fees, source: feeKind(entry.fees, entry.feeSource), currency: assetTradeCurrency(trade, input.settings) })), ...trade.closes.filter(close => close.date === date).map(close => ({ tradeId: trade.id, eventId: close.id, kind: 'close', date, amount: close.fees, source: feeKind(close.fees, close.feeSource), currency: assetTradeCurrency(trade, input.settings) }))]) },
      multiAsset: day,
    };
  };
  const nullNumbers = (value: unknown): unknown => typeof value === 'number' ? null : Array.isArray(value) ? value.map(nullNumbers) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, nullNumbers(item)])) : value;
  const legacyStatistics = legacyAvailable ? base.statistics : nullNumbers(base.statistics) as typeof base.statistics;
  const dailyDates = [...new Set([...periodRecords.map(record => record.date), ...events.map(event => event.date), ...(query.scope === 'today' || query.scope === 'positions' ? [today] : [])])].sort();
  const fullAccount = unified ? multiAssetSummary(authorizedTrades,input.settings,{instrument:'all',start,end}) : null;
  const completeSelected = selected.filter(trade=>multiAsset.completedTradeIds.includes(trade.id)),knownSelected=completeSelected.filter(trade=>positive(trade.initialRisk)&&(!trade.riskRuleSnapshot?.ruleCurrency||ledgerCurrency(trade.riskRuleSnapshot.ruleCurrency,input.settings)===assetTradeCurrency(trade,input.settings)));
  const meanR=(list:TradeRecord[])=>list.length?list.reduce((sum,trade)=>sum+totalRealized(trade)/trade.initialRisk!,0)/list.length:null;
  const avgWinR=meanR(knownSelected.filter(trade=>totalRealized(trade)>0)),avgLossR=meanR(knownSelected.filter(trade=>totalRealized(trade)<0)),knownPlanSample=knownSelected.filter(trade=>trade.inPlan).length;
  const unifiedAccountStatistics = fullAccount ? {...base.statistics.account,trades:fullAccount.closedCount,knownR:fullAccount.knownR,totalPnl:fullAccount.netPnl,totalR:fullAccount.totalR,expectancy:fullAccount.expectancy,newTrades:fullAccount.newTrades,profitFactor:fullAccount.profitFactor,profitFactorState:fullAccount.noLosingTrades?'unbounded-no-losses':fullAccount.profitFactor===null?'no-sample':'finite',grossProfit:fullAccount.grossProfit,grossLoss:fullAccount.grossLoss,winRate:fullAccount.winRate,maxDrawdown:fullAccount.accountSummary?.maxDrawdown??null,maxDrawdownPct:fullAccount.accountSummary?.maxDrawdownPct??null,realizedEquity:fullAccount.accountSummary?.realizedEquity??null,scope:'full-unified-account-all-instruments',currency:unified!.currency} : null;
  const unifiedSample = unified ? {...base.statistics.all,parentTradeCount:multiAsset.tradeCount,completedTradeCount:multiAsset.closedCount,newTradeCount:multiAsset.newTrades,closeEventCount:events.filter(event=>event.kind==='close').length,partialCloseEventCount:events.filter(event=>event.partial).length,periodRealizedNetPnl:multiAsset.netPnl,completedTradeNetPnl:completeSelected.every(trade=>assetTradeCurrency(trade,input.settings)===unified.currency)?completeSelected.reduce((sum,trade)=>sum+totalRealized(trade),0):null,totalR:multiAsset.totalR,averageR:multiAsset.averageR,netExpectancyR:multiAsset.expectancy,avgWinR,avgLossR,payoff:avgWinR!==null&&avgLossR!==null?avgWinR/Math.abs(avgLossR):null,knownR:multiAsset.knownR,rCoverage:multiAsset.closedCount?multiAsset.knownR/multiAsset.closedCount:null,winRate:multiAsset.winRate,profitFactor:multiAsset.profitFactor,profitFactorState:multiAsset.noLosingTrades?'unbounded-no-losses':multiAsset.profitFactor===null?'no-sample':'finite',knownPlanSample,sufficient:knownPlanSample>=input.settings.minTrades,sampleAssessment:knownPlanSample>=input.settings.minTrades?'达到参考样本数，仍不能证明稳定优势。':'样本不足，不能判定稳定优势。',tradeIds:selected.map(trade=>trade.id),completedTradeIds:multiAsset.completedTradeIds,currency:unified.currency,maxDrawdown:multiAsset.maxDrawdown,maxDrawdownPct:multiAsset.maxDrawdownPct,scope:'selected-instrument-contribution',drawdownBasis:{kind:'instrument-contribution-realized-cashflow',initialCapital:null,accountDrawdownSource:'statistics.unifiedAccount'}} : null;
  const eventSum = (sample: typeof events) => {
    let sum=0; for(const event of sample){const rate=conversionRate(input.settings,event.currency,unified!.currency,event.date);if(rate===null)return null;sum+=(event.data as {netPnl:number}).netPnl*rate;}return sum;
  };
  const unifiedCashflows = unified ? {periodRealizedNetPnl:eventSum(events.filter(event=>event.kind==='close'||event.kind==='legacy-summary')),partialCloseNetPnl:eventSum(events.filter(event=>event.partial)),finalCloseNetPnl:eventSum(events.filter(event=>event.kind==='close'&&event.completedParent)),legacySummaryNetPnl:eventSum(events.filter(event=>event.kind==='legacy-summary')),feesAlreadyIncludedInSavedNetPnl:true} : null;
  const feeEvents = selected.flatMap(trade => [...(trade.entries??[]).map(entry=>({tradeId:trade.id,eventId:entry.id,date:entry.date,fee:entry.fees,source:feeKind(entry.fees,entry.feeSource),currency:assetTradeCurrency(trade,input.settings),rawCurrency:rawTradeCurrency(trade,input.settings),kind:'entry'})),...trade.closes.map(close=>({tradeId:trade.id,eventId:close.id,date:close.date,fee:close.fees,source:feeKind(close.fees,close.feeSource),currency:assetTradeCurrency(trade,input.settings),rawCurrency:rawTradeCurrency(trade,input.settings),kind:'close'}))]).filter(event=>period(event.date,start,end));
  const feeSum=(source:string)=>{const list=feeEvents.filter(event=>event.source===source);if(!list.length)return null;let sum=0;for(const event of list){const rate=conversionRate(input.settings,event.currency,unified!.currency,event.date);if(rate===null)return null;sum+=event.fee!*rate;}return sum;};
  return {
    ...base,
    dataVersion: input.dataVersion ?? contentVersion({ ...input, records }),
    filters: { instrument, accountId, accountFilterIsOwnerLocal: true },
    context: { ...base.context, goldRulesScope: { instrument: unified?'all':'XAU', accountId: 'legacy', appliesToOtherInstruments: !!unified, scope: unified?'shared-gold-framework-risk-rules':'gold-reference-risk-amounts-only' }, sharedStrategyScope: { instruments: ['XAU', 'NQ', 'BTC'], frameworks: ['G1', 'independent', 'pending'], models: ['S1', 'S2', 'L1', 'L2'], contractAndRiskLimitsPerInstrument: !unified, historicalMissingFieldsRemainUnknown: true }, ledgerUnitCorrection:unified?.ledgerUnitCorrection??null, calculationBasis: [...base.context.calculationBasis, unified?'三品种统一原黄金USD账户及原G1/非G1风险区间；原USD/USDT/UNKNOWN标签仅按用户明确确认读时修正为USD，原始金额、费用、初始风险和历史快照不改写。账户本金只计算一次，账户资金曲线使用全部品种，筛选品种仅展示贡献。':'黄金、纳指、BTC共用原G1/非G1框架及S1/S2/L1/L2模型；未启用统一账户时保留旧账户与币种分桶。', unified?'statistics.account及statistics.unifiedAccount为完整统一账户；statistics.all及multiAsset为本次筛选贡献。':'旧statistics字段仅代表XAU原有账户及原设置币种；多品种使用statistics.multiAsset。', '每日情绪、精力和每日自报纪律为本人全局记录，未按品种或交易账户归因；逐笔纪律请查看multiAsset字段。'] },
    records: periodRecords.map(record => {
      const execution = dailyView(record.date);
      return { ...copy(record), trades: copy(goldRecords.find(day => day.date === record.date)?.trades ?? []), reportedNewTrades: record.reportedNewTrades ?? record.newTrades, reportedOpenPositions: record.reportedOpenPositions ?? record.openPositions, newTrades: execution.newParentTradeCount, openPositions: execution.currentPositions.parentTradeCount, execution, financialCountsDerived: true, personalStateScope: 'owner-global-not-attributed-to-instrument-or-account', screenshots: images.filter(image => image.entityType === 'daily' && image.dailyDate === record.date).map(imageReference) };
    }),
    dailySummaries: sameLegacyScope ? base.dailySummaries : dailyDates.map(dailyView),
    trades: selected.map(trade => tradeView(trade, images, start, end, input.settings)),
    currentPositions: current.map(trade => {
      const position = inventory(trade), risk = riskSnapshot(trade, input.settings);
      return { tradeId: trade.id, instrument: instrumentOf(trade), accountId: accountOf(trade, input.settings), rawAccountId: trade.accountId ?? null, status: trade.status, openedDate: trade.openedDate, openingDateKnown: trade.openedDate !== null, positionPresenceBasis: 'saved-current-status', remainingQuantityKnown: position.quantity !== null, classification: reviewClassification(trade), currency: assetTradeCurrency(trade, input.settings), rawCurrency: rawTradeCurrency(trade,input.settings), initialRisk: trade.initialRisk, originalStop: trade.originalStop, currentStop: trade.currentStop, inventory: position, risk, unrealizedPnlSource: trade.manualQuote ? 'manual-quote-estimate' : 'unknown', unrealizedExcludedFromStatistics: true, parentTrade: tradeView(trade, images, start, end, input.settings) };
    }),
    events,
    statistics: { ...legacyStatistics, ...(unified?{currency:unified.currency,account:unifiedAccountStatistics,all:unifiedSample,cashflows:unifiedCashflows,fees:{...base.statistics.fees,events:feeEvents,actualKnownSum:feeSum('actual'),estimatedSum:feeSum('estimated'),unspecifiedRecordedSum:feeSum('recorded-unspecified'),unknownCount:feeEvents.filter(event=>event.source==='unknown').length},scopes:{...base.statistics.scopes,account:'full-unified-account-all-instruments',all:'selected-instrument-contribution'}}:{}), unifiedAccount:fullAccount?.accountSummary??null, legacyStatisticsScope: { available: legacyAvailable&&!unified, instrument: 'XAU', accountId: 'legacy', currency: input.settings.accountCurrency ?? 'USD', excludesOtherAccounts: !unified, reason: unified?'已启用统一账户，account字段改为全部品种的原账户统计；all字段为筛选贡献。':legacyAvailable ? null : '本筛选使用multiAsset统计；旧黄金统计字段不可用，不能作为零收益或零回撤。' }, discipline: { ...base.statistics.discipline, attributedToInstrument: false, attributedToAccount: false, personalStateScope: 'owner-global' }, multiAsset, activity: { ...base.statistics.activity, newTradesScope: 'owner-local-filtered-formal-trades', noNewTrades: !newTrades.length, newParentTradeCount: newTrades.length, newParentTradeIds: newTrades.map(trade => trade.id), openEventCount: events.filter(event => event.kind === 'entry' || event.kind === 'aggregate-entry').length, detailedEntryEventCount: events.filter(event => event.kind === 'entry').length, aggregateEntryEventCount: events.filter(event => event.kind === 'aggregate-entry').length } },
    screenshots: images.map(imageReference),
    missingData: {
      ...base.missingData, noNewRecords: !periodRecords.length && !events.length, noNewTrades: !newTrades.length, noExecutedTrades: !selected.length,
      noCompletedTrades: sameLegacyScope ? base.missingData.noCompletedTrades : !multiAsset.closedCount,
      sampleInsufficient: sameLegacyScope ? base.missingData.sampleInsufficient : multiAsset.knownR < input.settings.minTrades,
      message: !periodRecords.length && !events.length ? '本期没有正式每日记录或交易事件；未生成补充记录。' : null,
      unknownOpeningDateTradeIds: selected.filter(trade => trade.openedDate === null).map(trade => trade.id),
      currentPositionOpeningDateUnknownTradeIds: current.filter(trade => trade.openedDate === null).map(trade => trade.id),
      currentPositionRemainingQuantityUnknownTradeIds: current.filter(trade => inventory(trade).quantity === null).map(trade => trade.id),
      unknownStrategyTradeIds: selected.filter(trade => reviewClassification(trade).strategy === 'unknown').map(trade => trade.id),
      unknownRulesTradeIds: selected.filter(trade => recordedRules(trade).status === 'unknown').map(trade => trade.id),
      originalApprovedRiskBudgetUnknownTradeIds: selected.filter(trade => recordedRules(trade).originalApprovedRiskBudget.status === 'unknown').map(trade => trade.id),
      completedRiskMissingTradeIds: selected.filter(trade => period(finalDate(trade), start, end) && !positive(trade.initialRisk)).map(trade => trade.id),
      legacySummaryTradeIds: selected.filter(isLegacySummary).map(trade => trade.id), missingConversions: multiAsset.missingConversions,
    },
  };
}

type ReviewEvent = {
  id: string; tradeId: string; kind: 'entry' | 'aggregate-entry' | 'close' | 'stop' | 'note' | 'legacy-summary';
  date: string; time: string | null; currency: string; data: unknown; partial?: boolean; completedParent?: boolean;
};
function tradeEvents(trade: TradeRecord, start: string, end: string): ReviewEvent[] {
  const currency = tradeCurrency(trade), events: ReviewEvent[] = [];
  for (const entry of trade.entries ?? []) if (period(entry.date, start, end)) events.push({ id: entry.id, tradeId: trade.id, kind: 'entry', date: entry.date, time: entry.time, currency, data: copy(entry) });
  if (!trade.entries?.length && !isLegacySummary(trade) && period(trade.openedDate, start, end)) events.push({ id: trade.id + ':aggregate-entry', tradeId: trade.id, kind: 'aggregate-entry', date: trade.openedDate!, time: trade.openedTime, currency, data: { quantity: trade.quantity, price: trade.entryPrice, fees: trade.aggregateEntryFee ?? null, source: 'saved-aggregate-fields', detailedExecutionsUnknown: true } });
  const last = orderedCloses(trade).at(-1);
  for (const close of trade.closes) if (period(close.date, start, end)) {
    const complete = trade.status === 'closed' && close.id === last?.id;
    events.push({ id: close.id, tradeId: trade.id, kind: 'close', date: close.date, time: close.time, currency, data: copy(close), partial: !complete, completedParent: complete });
  }
  for (const event of trade.events) if (period(event.date, start, end)) events.push({ id: event.id, tradeId: trade.id, kind: event.kind, date: event.date, time: event.time, currency, data: copy(event) });
  if (isLegacySummary(trade) && period(trade.legacy!.dailyDate, start, end)) events.push({ id: trade.id + ':legacy-summary', tradeId: trade.id, kind: 'legacy-summary', date: trade.legacy!.dailyDate, time: null, currency, data: { netPnl: trade.legacy!.netPnl, initialRisk: trade.initialRisk, source: copy(trade.legacy), detailedExecutionsUnknown: true }, completedParent: true });
  return events;
}

function sampleStatistics(trades: TradeRecord[], settings: Settings, start: string, end: string, history = trades) {
  const currency = settings.accountCurrency ?? 'USD';
  const ledger = ledgerDays([], trades, currency).filter(day => period(day.date, start, end));
  const stats = summarize(ledger, settings);
  const completed = trades.filter(trade => tradeCurrency(trade) === currency && period(finalDate(trade), start, end));
  const knownPlan = completed.filter(trade => trade.inPlan && positive(trade.initialRisk));
  const known = completed.filter(trade => positive(trade.initialRisk));
  const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const avgWinR = mean(known.filter(trade => totalRealized(trade) > 0).map(trade => totalRealized(trade) / trade.initialRisk!));
  const avgLossR = mean(known.filter(trade => totalRealized(trade) < 0).map(trade => totalRealized(trade) / trade.initialRisk!));
  const historyPoints = equitySeries(ledgerDays([], history, currency), settings).filter(day => period(day.date, start, end));
  return {
    parentTradeCount: trades.filter(trade => tradeCurrency(trade) === currency).length,
    completedTradeCount: stats.trades, newTradeCount: stats.newTrades,
    closeEventCount: stats.closeEvents, partialCloseEventCount: stats.partialEvents,
    periodRealizedNetPnl: stats.totalPnl,
    completedTradeNetPnl: completed.reduce((sum, trade) => sum + totalRealized(trade), 0),
    totalR: stats.totalR, averageR: stats.expectancy, netExpectancyR: stats.expectancy, avgWinR, avgLossR,
    payoff: avgWinR !== null && avgLossR !== null ? avgWinR / Math.abs(avgLossR) : null,
    knownR: stats.knownR,
    rCoverage: stats.trades ? stats.knownR / stats.trades : null,
    winRate: stats.winRate,
    profitFactor: stats.profitFactor !== null && Number.isFinite(stats.profitFactor) ? stats.profitFactor : null,
    profitFactorState: stats.profitFactor === Infinity ? 'unbounded-no-losses' : stats.profitFactor === null ? 'no-sample' : 'finite',
    requiredPlanSample: settings.minTrades, knownPlanSample: knownPlan.length,
    sufficient: knownPlan.length >= settings.minTrades,
    sampleAssessment: knownPlan.length >= settings.minTrades ? '达到设置的参考样本数，仍不能证明稳定优势。' : '样本不足，不能判定稳定优势。',
    maxDrawdown: historyPoints.length ? Math.max(...historyPoints.map(point => point.drawdown)) : 0,
    maxDrawdownPct: historyPoints.length ? Math.max(...historyPoints.map(point => point.drawdownPct)) : 0,
    drawdownBasis: { kind: 'group-realized-cashflow-high-water', initialCapital: settings.capital, historyStart: settings.start, retainsPriorPeriodHistory: true, excludesUnrealized: true, explanation: '使用本站equitySeries口径，以账户初始资金加本组按真实平仓日的净现金流计算高水位；保留设置起始日以来本组历史。此为本组独立净值参考，不可将各组回撤相加为账户回撤。' },
    discipline: { violationCount: null, adherenceRate: null, source: 'daily-records-not-attributed-to-trades', missingReason: '每日违规次数和纪律评分无法可靠归因到本组交易；账户每日来源单独列出。' },
    recordedExecutionFlags: { source: 'saved-trade-flags', outOfPlanTradeCount: trades.filter(trade => !trade.inPlan).length, riskFlagFalseTradeCount: trades.filter(trade => trade.riskCompliant === false).length, riskFlagUnknownTradeCount: trades.filter(trade => trade.riskCompliant === null).length, lossAddFlagTrueTradeCount: trades.filter(trade => trade.entries?.some(entry => entry.lossAdd === true)).length, inferredHistoricalViolations: false },
    tradeIds: trades.filter(trade => tradeCurrency(trade) === currency).map(trade => trade.id),
    completedTradeIds: completed.map(trade => trade.id),
    currency,
  };
}

function groups(trades: TradeRecord[], field: 'strategy' | 'direction' | 'model' | 'environment', settings: Settings, start: string, end: string, history = trades) {
  const defaults = field === 'strategy' ? ['G1-L', 'G1-S', 'S1', 'S2', 'L1', 'L2', 'other-independent', 'unknown'] : field === 'direction' ? ['long', 'short', 'unknown'] : field === 'model' ? ['S1', 'S2', 'L1', 'L2', 'G1', '其他'] : ['unknown'];
  const keys = [...new Set([...defaults, ...trades.map(trade => reviewClassification(trade)[field])])];
  return keys.map(key => ({ key, ...sampleStatistics(trades.filter(trade => reviewClassification(trade)[field] === key), settings, start, end, history.filter(trade => reviewClassification(trade)[field] === key)) }));
}

function frameworkGroups(trades: TradeRecord[], settings: Settings, start: string, end: string, history: TradeRecord[], withModel: boolean) {
  const frameworks = ['G1', 'independent', 'unknown'];
  const pairs = withModel ? frameworks.flatMap(framework => ['S1', 'S2', 'L1', 'L2', 'G1', '其他'].map(model => ({ framework, model }))) : frameworks.map(framework => ({ framework, model: null }));
  return pairs.map(({ framework, model }) => {
    const matches = (trade: TradeRecord) => reviewClassification(trade).framework === framework && (model === null || trade.model === model);
    return { key: model === null ? framework : framework + ':' + model, framework, model, ...sampleStatistics(trades.filter(matches), settings, start, end, history.filter(matches)) };
  });
}

function overlapsRange(trade: TradeRecord, start: string, end: string) {
  if (isLegacySummary(trade)) return period(trade.legacy!.dailyDate, start, end);
  if (trade.openedDate) return trade.openedDate <= end && (!finalDate(trade) || finalDate(trade)! >= start);
  // Completed legacy records may have real close details without a known opening date.
  // Match the recorded dates, retaining null opening metadata and the complete parent.
  const dates = [...(trade.entries ?? []).map(entry => entry.date), ...trade.closes.map(close => close.date), ...trade.events.map(event => event.date)];
  return dates.some(date => period(date, start, end)) || period(trade.legacy?.dailyDate, start, end) || period(finalDate(trade), start, end) || trade.status !== 'closed' && dates.some(date => date <= end);
}

/** Read-only projection of a single authorized database snapshot. Never persists or fabricates records. */
function buildGoldReviewData(input: ReviewInput, query: ReviewQuery, now = new Date()) {
  const range = reviewRange(query, now), { start, end, today } = range;
  const records = input.records.filter(record => record.isDraft !== true && record.status !== 'draft').sort((a, b) => a.date.localeCompare(b.date));
  const allTrades = compatibleTrades(records, input.trades).filter(trade => !trade.archived && hasExecution(trade));
  const current = allTrades.filter(trade => !isLegacySummary(trade) && trade.status !== 'closed' && (!trade.openedDate || trade.openedDate <= today));
  const selected = query.scope === 'positions' ? current : allTrades.filter(trade => overlapsRange(trade, start, end));
  const selectedIds = new Set(selected.map(trade => trade.id));
  const periodRecords = records.filter(record => period(record.date, start, end));
  const images = input.images.filter(image => (image.entityType ?? 'trade') === 'trade' ? selectedIds.has(image.tradeId) || current.some(trade => trade.id === image.tradeId) : image.entityType === 'daily' && periodRecords.some(record => record.date === image.dailyDate));
  const events = selected.flatMap(trade => tradeEvents(trade, start, end)).sort((a, b) => (a.date + 'T' + (a.time ?? '')).localeCompare(b.date + 'T' + (b.time ?? '')) || a.tradeId.localeCompare(b.tradeId) || a.id.localeCompare(b.id));
  const currency = input.settings.accountCurrency ?? 'USD';
  const ledger = ledgerDays(records, allTrades, currency);
  const points = equitySeries(ledger, input.settings).filter(day => period(day.date, start, end));
  const summary = summarize(ledger.filter(day => period(day.date, start, end)), input.settings, points);
  const account = { ...summary, profitFactor: summary.profitFactor !== null && Number.isFinite(summary.profitFactor) ? summary.profitFactor : null, profitFactorState: summary.profitFactor === Infinity ? 'unbounded-no-losses' : summary.profitFactor === null ? 'no-sample' : 'finite' };
  const sample = sampleStatistics(selected, input.settings, start, end, query.scope === 'positions' ? current : allTrades);
  const cashflows = events.filter(event => event.currency === currency && (event.kind === 'close' || event.kind === 'legacy-summary'));
  const amount = (event: ReviewEvent) => (event.data as { netPnl: number }).netPnl;
  const datedFees = selected.flatMap(trade => [...(trade.entries ?? []).filter(entry => period(entry.date, start, end)).map(entry => ({ tradeId: trade.id, eventId: entry.id, currency: tradeCurrency(trade), kind: 'entry', fee: entry.fees, source: feeKind(entry.fees, entry.feeSource) })), ...trade.closes.filter(close => period(close.date, start, end)).map(close => ({ tradeId: trade.id, eventId: close.id, currency: tradeCurrency(trade), kind: 'close', fee: close.fees, source: feeKind(close.fees, close.feeSource) }))]);
  const feeSum = (source: string) => { const list = datedFees.filter(fee => fee.currency === currency && fee.source === source); return list.length ? list.reduce((sum, fee) => sum + fee.fee!, 0) : null; };
  const newTrades = allTrades.filter(trade => period(trade.openedDate, start, end));
  const dateSet = new Set(periodRecords.map(record => record.date)), missingDates: string[] = [];
  for (let date = start; date <= end; date = addDays(date, 1)) if (!dateSet.has(date)) missingDates.push(date);
  const fieldGaps = selected.map(trade => ({ tradeId: trade.id, fields: [!positive(trade.initialRisk) ? 'initialRisk' : '', !trade.strategy ? 'strategy' : '', !trade.direction ? 'direction' : '', !trade.openedDate ? 'openedDate' : '', !trade.openedTime ? 'openedTime' : '', !trade.entries?.length ? 'detailedEntries' : '', isLegacySummary(trade) ? 'detailedCloses' : '', recordedRules(trade).status === 'unknown' ? 'ruleSnapshot' : ''].filter(Boolean) })).filter(gap => gap.fields.length);
  const dailyDates = [...new Set([...periodRecords.map(record => record.date), ...ledger.filter(day => period(day.date, start, end)).map(day => day.date), ...events.map(event => event.date), ...(query.scope === 'today' || query.scope === 'positions' ? [today] : [])])].sort();
  const dailySummaries = dailyDates.map(date => derivedDaily(allTrades, date, input.settings, today));
  const effectiveRules = currentEffectiveRules(input.settings);
  return {
    source: { name: '黄金策略实验室', url: URL, kind: 'owner-authorized-database-snapshot', readOnly: true, savedRecordsOnly: true },
    timezone: REVIEW_TIMEZONE,
    generatedAt: now.toISOString(), schemaVersion: REVIEW_SCHEMA_VERSION, range,
    dataVersion: input.dataVersion ?? contentVersion({ ...input, records }),
    lastUpdatedAt: input.lastUpdatedAt ?? null,
    metadata: copy(input.metadata ?? {}),
    context: { currentSettings: copy(input.settings), currentEffectiveRules: copy(effectiveRules), referenceRiskBudgets: { A: effectiveRules.G1.hardLimit, B: effectiveRules.independent.hardLimit, normalA: { min: effectiveRules.G1.normalMin, max: effectiveRules.G1.normalMax }, normalB: { min: effectiveRules.independent.normalMin, max: effectiveRules.independent.normalMax }, trialB: { durationDays: effectiveRules.independent.trialDays, prohibitsAddingToLosingPosition: effectiveRules.independent.noLossAddsDuringTrial, effectiveAt: effectiveRules.independent.effectiveAt }, currency: effectiveRules.currency, informationalOnly: true, appliesRetroactively: false, explanation: '当前双层风险规则已采纳，实际有效版本见currentEffectiveRules；这里只提供当前参考，不替换保存的初始风险、批准预算、原规则或历史R。' }, calculationBasis: ['期内净损益按每次真实平仓日期计入，旧汇总按原日报日期计入；不再次扣除费用。', '完整平仓父交易仅在最终平仓日计一个样本，以全部平仓净损益除以保存的初始风险。部分平仓现金流不作为完整交易R样本。', '当前持仓为读取时保存的状态；历史区间保留完整父交易，不能据此声称当时已全部平仓。', '不同结算货币不换算；账户统计仅使用账户设置货币。', '每日新开仓、持仓、费用与净损益来自正式父交易及事件；旧自报计数仅留reported字段。未记录的字段为未知；不读取草稿，不补造记录。', 'positions范围的trades、all及分组统计仅含当前持仓；account始终按全体正式交易和每日记录计算，与网站账户口径一致。'] },
    records: periodRecords.map(record => {
      const execution = derivedDaily(allTrades, record.date, input.settings, today);
      return { ...copy(record), reportedNewTrades: record.reportedNewTrades ?? record.newTrades, reportedOpenPositions: record.reportedOpenPositions ?? record.openPositions, newTrades: execution.newParentTradeCount, openPositions: execution.currentPositions.parentTradeCount, execution, financialCountsDerived: true, screenshots: images.filter(image => image.entityType === 'daily' && image.dailyDate === record.date).map(imageReference) };
    }),
    dailySummaries,
    trades: selected.map(trade => tradeView(trade, images, start, end)),
    currentPositions: current.map(trade => {
      const position = inventory(trade);
      return { tradeId: trade.id, status: trade.status, openedDate: trade.openedDate, openingDateKnown: trade.openedDate !== null, positionPresenceBasis: 'saved-current-status', remainingQuantityKnown: position.quantity !== null, classification: reviewClassification(trade), currency: tradeCurrency(trade), initialRisk: trade.initialRisk, originalStop: trade.originalStop, currentStop: trade.currentStop, inventory: position, risk: riskSnapshot(trade, input.settings), unrealizedPnlSource: trade.manualQuote ? 'manual-quote-estimate' : 'unknown', unrealizedExcludedFromStatistics: true, parentTrade: tradeView(trade, images, start, end) };
    }),
    events,
    statistics: {
      currency, account, all: sample,
      scopes: { account: 'all-saved-formal-trades-and-daily-records', all: query.scope === 'positions' ? 'current-position-parents-only' : 'all-parents-overlapping-range', cashflows: query.scope === 'positions' ? 'current-position-parents-period-closes-only' : 'all-parent-period-closes' },
      activity: { newTradesScope: 'all-saved-formal-trades', openEventsScope: query.scope === 'positions' ? 'current-position-parents' : 'all-parents-overlapping-range', noNewTrades: !newTrades.length, newParentTradeCount: newTrades.length, newParentTradeIds: newTrades.map(trade => trade.id), openEventCount: events.filter(event => event.kind === 'entry' || event.kind === 'aggregate-entry').length, detailedEntryEventCount: events.filter(event => event.kind === 'entry').length, aggregateEntryEventCount: events.filter(event => event.kind === 'aggregate-entry').length },
      discipline: { violationCount: summary.days ? summary.violations : null, adherenceRate: summary.complianceRate, score: summary.score, dailyRecordCount: summary.days, assessedDailyRecordCount: summary.disciplineCoverage, source: 'saved-daily-records', sourceDates: periodRecords.map(record => record.date), unassessedDates: periodRecords.filter(record => record.disciplineAssessed === false).map(record => record.date), unrecordedDates: missingDates, attributedToStrategy: false },
      cashflows: { periodRealizedNetPnl: cashflows.reduce((sum, event) => sum + amount(event), 0), partialCloseNetPnl: cashflows.filter(event => event.partial).reduce((sum, event) => sum + amount(event), 0), finalCloseNetPnl: cashflows.filter(event => event.kind === 'close' && event.completedParent).reduce((sum, event) => sum + amount(event), 0), legacySummaryNetPnl: cashflows.filter(event => event.kind === 'legacy-summary').reduce((sum, event) => sum + amount(event), 0), feesAlreadyIncludedInSavedNetPnl: true },
      fees: { events: datedFees, actualKnownSum: feeSum('actual'), estimatedSum: feeSum('estimated'), unspecifiedRecordedSum: feeSum('recorded-unspecified'), unknownCount: datedFees.filter(fee => fee.currency === currency && fee.source === 'unknown').length, aggregateEntryFees: selected.filter(trade => !trade.entries?.length).map(trade => ({ tradeId: trade.id, date: trade.openedDate, amount: trade.aggregateEntryFee ?? null, currency: tradeCurrency(trade), source: trade.aggregateEntryFee == null ? 'unknown' : 'recorded-unspecified' })) },
      byStrategy: groups(selected, 'strategy', input.settings, start, end, allTrades), byDirection: groups(selected, 'direction', input.settings, start, end, allTrades), byModel: groups(selected, 'model', input.settings, start, end, allTrades), byEnvironment: groups(selected, 'environment', input.settings, start, end, allTrades),
      byFramework: frameworkGroups(selected, input.settings, start, end, allTrades, false), byFrameworkModel: frameworkGroups(selected, input.settings, start, end, allTrades, true),
      research: researchStatistics(query.scope === 'positions' ? selected : allTrades, input.settings, start, end),
      excludedCurrencyTradeIds: selected.filter(trade => tradeCurrency(trade) !== currency).map(trade => trade.id),
      formalReturnsExcludeUnrealized: true,
    },
    screenshots: images.map(imageReference),
    missingData: {
      noNewRecords: !periodRecords.length && !events.length,
      noNewTrades: !newTrades.length,
      unknownOpeningDateTradeIds: selected.filter(trade => trade.openedDate === null).map(trade => trade.id),
      currentPositionOpeningDateUnknownTradeIds: current.filter(trade => trade.openedDate === null).map(trade => trade.id),
      currentPositionRemainingQuantityUnknownTradeIds: current.filter(trade => inventory(trade).quantity === null).map(trade => trade.id),
      message: !periodRecords.length && !events.length ? '本期没有正式每日记录或交易事件；未生成补充记录。' : null,
      noExecutedTrades: !selected.length, noCompletedTrades: !sample.completedTradeCount,
      unrecordedDailyDates: missingDates, tradeFields: fieldGaps,
      unknownStrategyTradeIds: selected.filter(trade => reviewClassification(trade).strategy === 'unknown').map(trade => trade.id),
      unknownRulesTradeIds: selected.filter(trade => recordedRules(trade).status === 'unknown').map(trade => trade.id),
      originalApprovedRiskBudgetUnknownTradeIds: selected.filter(trade => recordedRules(trade).originalApprovedRiskBudget.status === 'unknown').map(trade => trade.id),
      completedRiskMissingTradeIds: selected.filter(trade => period(finalDate(trade), start, end) && !positive(trade.initialRisk)).map(trade => trade.id),
      legacySummaryTradeIds: selected.filter(isLegacySummary).map(trade => trade.id),
      imageContentInspected: false, screenshotReferencesRequireOwnerAuthorization: true,
      sampleInsufficient: !sample.sufficient,
    },
  };
}
