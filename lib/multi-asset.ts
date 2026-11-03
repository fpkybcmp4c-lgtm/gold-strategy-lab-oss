import type { Settings } from './domain.ts';
import { periodKey } from './domain.ts';
import { DEFAULT_G1 } from './g1-schema.ts';
import type { ContractConfig } from './g1-schema.ts';
import { executionTimeKey, finalDate, hasExecution, instrumentOf, isLegacySummary, orderedCloses, totalRealized, tradeCurrency } from './trading.ts';
import type { TradeRecord } from './trading.ts';
import { INSTRUMENTS } from './multi-asset-schema.ts';
import type { Instrument } from './multi-asset-schema.ts';
import { ENTRY_APPROACH_OPTIONS, REGIME_OPTIONS } from './vnext-schema.ts';
import { savedFramework } from './vnext-stats.ts';
import { defaultProfileSymbol, knownContractProfile } from './contract-profiles.ts';
import { riskSnapshot } from './g1.ts';
export { INSTRUMENTS, instrumentOf };
export type { Instrument } from './multi-asset-schema.ts';
export const INSTRUMENT_LABELS: Record<Instrument, string> = { XAU: '黄金', NQ: '纳指', BTC: 'BTC' };
export const DEFAULT_UNIFIED_ACCOUNT: NonNullable<NonNullable<Settings['multiAsset']>['unifiedAccount']> = { enabled: true, currency: 'USD', capital: 10000 };
export function unifiedAccountConfig(settings: Settings) { return settings.multiAsset?.unifiedAccount?.enabled ? settings.multiAsset.unifiedAccount : null; }
/** Explicit owner-confirmed ledger label correction, never an assumed currency peg. */
export function ledgerCurrency(currency: string | undefined, settings: Settings) {
  const account = unifiedAccountConfig(settings), correction = account?.ledgerUnitCorrection, raw = currency ?? 'UNKNOWN';
  return correction?.confirmed && correction.source.trim() && correction.labels.includes(raw) ? account!.currency : raw;
}
export function ledgerContract(contract: ContractConfig, settings: Settings): ContractConfig {
  if (!unifiedAccountConfig(settings)) return contract;
  return { ...contract, currency: ledgerCurrency(contract.currency, settings), ...(contract.feeCurrency === undefined ? {} : { feeCurrency: ledgerCurrency(contract.feeCurrency, settings) }) };
}
export const unknownContract = (): ContractConfig => ({ confirmed: false, usdPerPriceUnit: null, entryFeePerQty: null, exitFeePerQty: null, slippagePrice: null, quantityStep: null, currency: 'UNKNOWN', settlement: 'linear', feeMode: 'perQuantity' });

/** Defaults are read-time projections. Historical records and settings are never rewritten. */
export function instrumentConfig(settings: Settings, instrument: Instrument) {
  const saved = settings.multiAsset?.instruments?.[instrument], gold = settings.g1 ?? DEFAULT_G1, unified = unifiedAccountConfig(settings);
  const symbol = saved?.symbol?.trim() ? saved.symbol : unified ? defaultProfileSymbol(instrument) : instrument === 'XAU' ? 'XAUUSDT.P' : '';
  return {
    symbol,
    accountId: unifiedAccountConfig(settings) ? 'legacy' : saved?.accountId ?? (instrument === 'XAU' ? 'legacy' : ''), quoteSource: saved?.quoteSource ?? '',
    contract: ledgerContract(saved?.contract ?? (instrument === 'XAU' ? gold.contract : unified ? knownContractProfile(symbol) ?? unknownContract() : unknownContract()), settings),
    models: ['S1', 'S2', 'L1', 'L2', 'G1', '其他'],
    environments: saved?.environments ?? (instrument === 'XAU' ? ['明确上涨', '明确下跌', '窄幅震荡', '宽幅混乱', '无趋势'] : []),
    executionModes: saved?.executionModes ?? [],
    riskLimit: saved?.riskLimit === undefined ? instrument === 'XAU' ? settings.riskLimit : null : saved.riskLimit,
    normalRisk: saved?.normalRisk === undefined ? instrument === 'XAU' ? gold.normalRiskMax : null : saved.normalRisk,
  };
}
export function accountOf(trade: TradeRecord, settings?: Settings) { return settings && unifiedAccountConfig(settings) ? 'legacy' : trade.accountId || (instrumentOf(trade) === 'XAU' ? 'legacy' : `unassigned:${instrumentOf(trade)}`); }
export function rawTradeCurrency(trade: TradeRecord, settings: Settings) { return trade.contract?.currency ?? (instrumentOf(trade) === 'XAU' ? tradeCurrency(trade) : settings.multiAsset?.instruments?.[instrumentOf(trade)]?.contract?.currency ?? 'UNKNOWN'); }
export function assetTradeCurrency(trade: TradeRecord, settings: Settings) { return ledgerCurrency(rawTradeCurrency(trade, settings), settings); }
export function modelOf(trade: TradeRecord) { return trade.model === '其他' && trade.researchModel ? trade.researchModel : trade.model; }
export function frameworkOf(trade: TradeRecord) { const value=savedFramework(trade);return value==='G1'?'G1':value==='independent'?'非G1':'待确认'; }
export function environmentOf(trade:TradeRecord) { const value=trade.environment||trade.entrySnapshot?.regime;return value ? REGIME_OPTIONS.find(([id])=>id===value)?.[1]??value : '未记录'; }
export function executionModeOf(trade:TradeRecord) { const value=trade.executionMode||trade.entrySnapshot?.entryApproach;return value?ENTRY_APPROACH_OPTIONS.find(([id])=>id===value)?.[1]??value:'未记录'; }
export function accountConfig(settings: Settings, id: string) {
  const unified = unifiedAccountConfig(settings);
  if (unified) return { id: 'legacy', name: '原黄金统一交易账户', currency: unified.currency, capital: unified.capital };
  return settings.multiAsset?.accounts?.find(a => a.id === id) ?? (id === 'legacy' ? { id, name: '原有账户', currency: settings.accountCurrency ?? 'USD', capital: settings.capital } : null);
}

/** Only a confirmed, sourced rate for the exact event date is eligible. No stablecoin peg is assumed. */
export function conversionRate(settings: Settings, from: string, to: string, date: string): number | null {
  from = ledgerCurrency(from, settings); to = ledgerCurrency(to, settings);
  if (from === 'UNKNOWN' || to === 'UNKNOWN') return null;
  if (from === to) return 1;
  const rates = (settings.multiAsset?.fxRates ?? []).filter(r => r.confirmed && r.date === date && r.source.trim() && Number.isFinite(r.rate) && r.rate > 0);
  const direct = rates.find(r => r.from === from && r.to === to), inverse = rates.find(r => r.from === to && r.to === from);
  // Contradictory manual entries cannot silently choose one direction.
  if (direct && inverse && Math.abs(direct.rate * inverse.rate - 1) > 1e-6) return null;
  return direct?.rate ?? (inverse ? 1 / inverse.rate : null);
}
type CashEvent = { date: string; time: string | null; id: string; tradeId: string; accountId: string; instrument: Instrument; currency: string; netPnl: number };
function cashEvents(trade: TradeRecord, settings: Settings): CashEvent[] {
  const base = { tradeId: trade.id, accountId: accountOf(trade, settings), instrument: instrumentOf(trade), currency: assetTradeCurrency(trade, settings) };
  return isLegacySummary(trade) ? [{ ...base, id: trade.id, date: trade.legacy!.dailyDate, time: null, netPnl: trade.legacy!.netPnl }] : trade.closes.map(c => ({ ...base, id: c.id, date: c.date, time: c.time, netPnl: c.netPnl }));
}
const mean = (values: number[]) => values.length ? values.reduce((s, n) => s + n, 0) / values.length : null;
function sumConverted(events: CashEvent[], settings: Settings, currency: string) {
  let sum = 0;
  for (const event of events) { const rate = conversionRate(settings, event.currency, currency, event.date); if (rate === null || !Number.isFinite(event.netPnl)) return null; sum += event.netPnl * rate; }
  // Stabilize only the final derived amount; preserve every saved event and its
  // sub-cent precision while avoiding order-dependent tails at half-cent ties.
  const amount = Math.round((sum + Number.EPSILON) * 1e8) / 1e8;
  return amount === 0 ? 0 : amount;
}
function tradeR(t: TradeRecord, settings: Settings) {
  const ruleCurrency = t.riskRuleSnapshot?.ruleCurrency;
  return t.initialRisk != null && Number.isFinite(t.initialRisk) && t.initialRisk > 0 && (!ruleCurrency || ledgerCurrency(ruleCurrency, settings) === assetTradeCurrency(t, settings)) ? totalRealized(t) / t.initialRisk : null;
}
/** Cash paid for the still-open inventory, separate from allocated close-net costs. */
function paidEntryFeeRemainder(trade: TradeRecord, settings: Settings, end: string) {
  const money=(value:number)=>Math.round((value+Number.EPSILON)*1e8)/1e8;
  const entries=trade.entries?.length?trade.entries:[{id:trade.id+':aggregate-entry',date:trade.openedDate??'',time:trade.openedTime,quantity:trade.quantity,fees:trade.aggregateEntryFee??null,feeSource:trade.aggregateEntryFeeSource==='actual'?'actual' as const:trade.aggregateEntryFeeSource==='estimated'?'estimated' as const:undefined}];
  const events=[...entries.filter(entry=>entry.date<=end).map(entry=>({key:executionTimeKey(entry.date,entry.time),entry,close:null})),...trade.closes.filter(close=>close.date<=end).map(close=>({key:executionTimeKey(close.date,close.time,'23:59:59'),entry:null,close}))].sort((a,b)=>a.key.localeCompare(b.key)||(a.entry&&b.entry?a.entry.id.localeCompare(b.entry.id):a.entry?-1:b.entry?1:a.close!.id.localeCompare(b.close!.id)));
  let quantity=0,quantityKnown=true,paid=0;
  const unknownEntries=new Set<string>(),unknownAllocations=new Set<string>();
  for(const event of events){
    if(event.entry){
      const entry=event.entry;
      if(entry.quantity===null)quantityKnown=false;else quantity+=entry.quantity;
      if(entry.feeSource==='actual'&&entry.fees!==null&&Number.isFinite(entry.fees)&&entry.fees>=0)paid=money(paid+entry.fees);else unknownEntries.add(entry.id);
    }else if(event.close){
      const close=event.close,q=close.quantity,tolerance=quantity*1e-8;
      if(!quantityKnown||q===null||q<=0||q>quantity+tolerance||quantity<=0){unknownAllocations.add(close.id);continue;}
      if(q>=quantity-tolerance){quantity=0;paid=0;quantityKnown=true;unknownEntries.clear();unknownAllocations.clear();continue;}
      const recorded=close.allocatedEntryFee;
      if(!unknownEntries.size&&recorded!=null&&Number.isFinite(recorded)&&recorded>=0&&recorded<=paid+1e-8)paid=money(Math.max(0,paid-recorded));
      else{
        paid=money(paid-money(paid*q/quantity));
        // A reported broker net is authoritative, but does not establish how
        // much entry cost it included unless allocation was saved explicitly.
        if(!unknownEntries.size&&(close.calculationMode!=='automatic'||recorded!=null))unknownAllocations.add(close.id);
      }
      quantity=Math.max(0,quantity-q);
    }
  }
  const currency=assetTradeCurrency(trade,settings),known=currency===(unifiedAccountConfig(settings)?.currency??'USD')&&!unknownEntries.size&&!unknownAllocations.size;
  return {tradeId:trade.id,currency,amount:known?paid:null,unknownEntryFeeIds:[...unknownEntries],unknownAllocationCloseIds:[...unknownAllocations],source:'actual-paid-entry-fees-minus-entry-fees-already-allocated-to-close-net'};
}
function executionViolations(t: TradeRecord) {
  const reasons = new Set(t.psychology?.deviationReasons ?? []);
  if (!t.inPlan) reasons.add('unplanned_entry');
  if (t.riskCompliant === false) reasons.add('risk_excess');
  if (t.invalidationRecord?.widenedStop || t.psychology?.stopChangedWithoutPlan) reasons.add('widened_stop');
  if (t.invalidationRecord?.riskIncreasingAdd || t.entries?.some(e => e.lossAdd)) reasons.add('unplanned_add');
  return reasons.size;
}
function disciplineEvidence(t: TradeRecord):number|null {
  const value = t.psychology?.discipline;
  return value === 'full' ? 100 : value === 'partial' ? 50 : value === 'violated' ? 0 : null;
}
function currencyBuckets(events: CashEvent[], closed: TradeRecord[], settings: Settings) {
  return [...new Set([...events.map(e => e.currency), ...closed.map(t => assetTradeCurrency(t, settings))])].sort().map(currency => {
    const sample = closed.filter(t => assetTradeCurrency(t, settings) === currency), values = sample.map(totalRealized), wins = values.filter(v => v > 0), losses = values.filter(v => v < 0), profit = wins.reduce((s, n) => s + n, 0), loss = -losses.reduce((s, n) => s + n, 0);
    return { currency, netPnl: events.filter(e => e.currency === currency).reduce((s, e) => s + e.netPnl, 0), closedCount: sample.length, winRate: values.length ? wins.length * 100 / values.length : null, grossProfit: profit, grossLoss: loss, profitFactor: loss > 0 ? profit / loss : null, noLosingTrades: sample.length > 0 && loss === 0, payoff: wins.length && losses.length ? mean(wins)! / -mean(losses)! : null };
  });
}
function streaks(closed: TradeRecord[]) {
  const ordered = [...closed].sort((a, b) => (finalDate(a) ?? '').localeCompare(finalDate(b) ?? '') || (orderedCloses(a).at(-1)?.time ?? '').localeCompare(orderedCloses(b).at(-1)?.time ?? '') || a.id.localeCompare(b.id));
  const ambiguous = ordered.some((t, i) => i > 0 && finalDate(t) === finalDate(ordered[i - 1]) && (!orderedCloses(t).at(-1)?.time || !orderedCloses(ordered[i - 1]).at(-1)?.time || orderedCloses(t).at(-1)?.time === orderedCloses(ordered[i - 1]).at(-1)?.time));
  let win = 0, loss = 0, winStreak = 0, lossStreak = 0;
  for (const trade of ordered) { const n = totalRealized(trade); win = n > 0 ? win + 1 : 0; loss = n < 0 ? loss + 1 : 0; winStreak = Math.max(winStreak, win); lossStreak = Math.max(lossStreak, loss); }
  return { winStreak: ambiguous ? null : winStreak, lossStreak: ambiguous ? null : lossStreak, streakOrderKnown: !ambiguous };
}
export type MultiAssetFilters = { instrument?: 'all' | Instrument; accountId?: string; start: string; end: string };

export function multiAssetSummary(trades: TradeRecord[], settings: Settings, filters: MultiAssetFilters) {
  const { start, end } = filters, unified = unifiedAccountConfig(settings), currency = unified?.currency ?? settings.multiAsset?.baseCurrency ?? settings.accountCurrency ?? 'USD';
  const formal = trades.filter(t => !t.archived && hasExecution(t));
  const scoped = formal.filter(t => (!filters.instrument || filters.instrument === 'all' || instrumentOf(t) === filters.instrument) && (!filters.accountId || filters.accountId === 'all' || accountOf(t, settings) === filters.accountId || !!unified && t.accountId === filters.accountId));
  const selected = scoped.filter(t => start<=end && (t.openedDate ?? t.legacy?.dailyDate ?? '') <= end && (!finalDate(t) || finalDate(t)! >= start));
  const closed = selected.filter(t => t.status === 'closed' && !!finalDate(t) && finalDate(t)! >= start && finalDate(t)! <= end);
  const events = selected.flatMap(t => cashEvents(t, settings)).filter(e => e.date >= start && e.date <= end);
  const netPnl = sumConverted(events, settings, currency), buckets = currencyBuckets(events, closed, settings);
  const closedAmounts = closed.map(t => sumConverted(cashEvents(t, settings), settings, currency)), completeOutcomes = closedAmounts.every((n): n is number => n !== null);
  const wins = completeOutcomes ? (closedAmounts as number[]).filter(n => n > 0) : [], losses = completeOutcomes ? (closedAmounts as number[]).filter(n => n < 0) : [];
  const grossProfit = completeOutcomes ? wins.reduce((s, n) => s + n, 0) : null, grossLoss = completeOutcomes ? -losses.reduce((s, n) => s + n, 0) : null;
  const rs = closed.map(t => tradeR(t, settings)).filter((n): n is number => n !== null), rated = selected.map(disciplineEvidence).filter((n): n is number => n !== null), fomo = selected.map(t => t.psychology?.fomo).filter((n): n is number => n != null);
  const allEvents = scoped.flatMap(t => cashEvents(t, settings)).filter(e => e.date >= settings.start && e.date <= end), accountKeys = [...new Set(allEvents.map(e => `${e.accountId}\u0000${e.currency}`))];
  const accountCurves = accountKeys.map(key => {
    const [accountId, nativeCurrency] = key.split('\u0000'), account = accountConfig(settings, accountId),accountKnown=!accountId.startsWith('unassigned:');
    const contribution=!!filters.instrument&&filters.instrument!=='all'&&(!!unified||trades.some(t=>!t.archived&&hasExecution(t)&&accountOf(t,settings)===accountId&&instrumentOf(t)!==filters.instrument));
    const capital = !contribution&&account?.currency === nativeCurrency ? account.capital : null;
    const history = allEvents.filter(e => e.accountId === accountId && e.currency === nativeCurrency).sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? '') || a.id.localeCompare(b.id));
    const ambiguous = history.some((event, index) => index > 0 && event.date === history[index - 1].date && (!event.time || !history[index - 1].time || event.time === history[index - 1].time));
    let cumulative = 0, peak = capital ?? 0;
    const points = history.map(event => { cumulative += event.netPnl; const equity = capital === null ? null : capital + cumulative, level = equity ?? cumulative; peak = Math.max(peak, level); const drawdown = Math.max(0, peak - level); return { date:event.date,time:event.time,eventId:event.id,dailyPnl:event.netPnl,cumulative,equity,drawdown,drawdownPct:capital !== null && peak > 0 ? 100 * drawdown / peak : null }; }).filter(p => p.date >= start);
    return { accountId, currency: nativeCurrency, capital,accountKnown,scope:contribution?'instrument-contribution':'account',basis: 'realized-net-pnl' as const,basisStart:settings.start, orderKnown:!ambiguous,points, maxDrawdown: ambiguous||!accountKnown?null:Math.max(0, ...points.map(p => p.drawdown)), maxDrawdownPct: capital === null||ambiguous||!accountKnown ? null : Math.max(0, ...points.map(p => p.drawdownPct ?? 0)) };
  }).filter(a => a.points.length > 0);
  const groupStats = (keyOf: (t: TradeRecord) => string) => [...new Set(selected.map(keyOf))].sort().map(key => {
    const sample = selected.filter(t => keyOf(t) === key), complete = closed.filter(t => keyOf(t) === key), sampleEvents = events.filter(e => sample.some(t => t.id === e.tradeId)), groupRs = complete.map(t => tradeR(t, settings)).filter((n): n is number => n !== null);
    return { key, tradeCount: sample.length, closedCount: complete.length, winRate: complete.length ? 100 * complete.filter(t => totalRealized(t) > 0).length / complete.length : null, netPnl: sumConverted(sampleEvents, settings, currency), totalR: groupRs.length ? groupRs.reduce((s, n) => s + n, 0) : null, averageR: mean(groupRs), knownR: groupRs.length, currencyBuckets: currencyBuckets(sampleEvents, complete, settings) };
  });
  const periods = Object.fromEntries((['day', 'week', 'month'] as const).map(granularity => [granularity, [...new Set(events.map(e => periodKey(e.date, granularity)))].sort().map(key => {
    const sampleEvents = events.filter(e => periodKey(e.date, granularity) === key), sample = closed.filter(t => periodKey(finalDate(t)!, granularity) === key), periodRs = sample.map(t => tradeR(t, settings)).filter((n): n is number => n !== null);
    return { key, currency, netPnl: sumConverted(sampleEvents, settings, currency), currencyBuckets: currencyBuckets(sampleEvents, sample, settings), closedCount: sample.length, totalR: periodRs.length ? periodRs.reduce((s, n) => s + n, 0) : null };
  })])) as Record<'day' | 'week' | 'month', { key: string; currency: string; netPnl: number | null; currencyBuckets: ReturnType<typeof currencyBuckets>; closedCount: number; totalR: number | null }[]>;
  const accountSummary = (() => {
    if (!unified) return null;
    const history = formal.flatMap(trade => cashEvents(trade, settings)).filter(event => event.date >= settings.start && event.date <= end).sort((a,b) => (a.date+'T'+(a.time??'')).localeCompare(b.date+'T'+(b.time??'')) || a.tradeId.localeCompare(b.tradeId) || a.id.localeCompare(b.id));
    const orderKnown = !history.some((event,index) => index > 0 && event.date === history[index-1].date && (!event.time || !history[index-1].time || event.time === history[index-1].time));
    let cumulative = 0, peak = unified.capital, complete = true;
    const points = history.map(event => {
      const rate = conversionRate(settings,event.currency,unified.currency,event.date);
      if (rate === null) complete = false;
      const pnl = rate === null ? null : event.netPnl*rate;
      if (pnl !== null) cumulative += pnl;
      const equity = complete ? unified.capital+cumulative : null;
      if (equity !== null) peak = Math.max(peak,equity);
      const drawdown = equity === null ? null : Math.max(0,peak-equity);
      return {date:event.date,time:event.time,eventId:event.id,tradeId:event.tradeId,instrument:event.instrument,pnl,cumulative:complete?cumulative:null,equity,drawdown,drawdownPct:drawdown===null||peak<=0?null:100*drawdown/peak};
    }).filter(point => point.date >= start);
    const fullNetPnl = sumConverted(history,settings,unified.currency), periodEvents = history.filter(event => event.date >= start);
    const positions = formal.filter(trade=>!isLegacySummary(trade)&&trade.status!=='closed').map(trade=>({tradeId:trade.id,instrument:instrumentOf(trade),symbol:trade.symbol,accountId:'legacy',rawAccountId:trade.accountId??null,currency:assetTradeCurrency(trade,settings),rawCurrency:rawTradeCurrency(trade,settings),initialRisk:trade.initialRisk,quoteAt:trade.manualQuote?.at??null,manualQuotePresent:!!trade.manualQuote,risk:riskSnapshot(trade,settings)}));
    const exposure = (rows:typeof positions) => {
      const sum=(key:'hypothesisRisk'|'openRisk'|'grossStopRisk'|'unrealized'|'grossUnrealized')=>rows.every(row=>row.currency===unified.currency&&row.risk[key]!==null&&Number.isFinite(row.risk[key]))?rows.reduce((total,row)=>total+row.risk[key]!,0):null;
      const knownGross=rows.filter(row=>row.currency===unified.currency&&row.risk.grossStopRisk!==null);
      return {positionCount:rows.length,hypothesisRisk:sum('hypothesisRisk'),remainingStopRisk:sum('openRisk'),grossStopRisk:sum('grossStopRisk'),knownGrossStopRisk:knownGross.reduce((total,row)=>total+row.risk.grossStopRisk!,0),grossRiskCoverage:knownGross.length,unrealizedNetPnl:sum('unrealized'),unrealizedGrossPnl:sum('grossUnrealized'),quoteCoverage:rows.filter(row=>row.risk.grossUnrealized!==null).length,missingQuoteTradeIds:rows.filter(row=>!row.manualQuotePresent).map(row=>row.tradeId),unknownRiskTradeIds:rows.filter(row=>row.currency!==unified.currency||row.risk.hypothesisRisk===null).map(row=>row.tradeId),currencyMismatchTradeIds:rows.filter(row=>row.currency!==unified.currency).map(row=>row.tradeId)};
    };
    const totals = exposure(positions), realizedEquity = fullNetPnl===null?null:unified.capital+fullNetPnl;
    const paidUnallocatedEntryFeeDetails=formal.filter(trade=>!isLegacySummary(trade)&&(!finalDate(trade)||finalDate(trade)!>end)&&(!!trade.openedDate&&trade.openedDate<=end||trade.entries?.some(entry=>entry.date<=end)||trade.closes.some(close=>close.date<=end))).map(trade=>paidEntryFeeRemainder(trade,settings,end));
    const paidUnallocatedEntryFees=paidUnallocatedEntryFeeDetails.every(detail=>detail.amount!==null)?Math.round((paidUnallocatedEntryFeeDetails.reduce((sum,detail)=>sum+detail.amount!,0)+Number.EPSILON)*1e8)/1e8:null;
    const recordedCashBalance=realizedEquity===null||paidUnallocatedEntryFees===null?null:Math.round((realizedEquity-paidUnallocatedEntryFees+Number.EPSILON)*1e8)/1e8;
    const paidUnallocatedEntryFeeCoverage={positionCount:paidUnallocatedEntryFeeDetails.length,knownPositionCount:paidUnallocatedEntryFeeDetails.filter(detail=>detail.amount!==null).length,unknownTradeIds:paidUnallocatedEntryFeeDetails.filter(detail=>detail.amount===null).map(detail=>detail.tradeId)};
    const currentExposure = {...totals,currency:unified.currency,accountId:'legacy',source:'saved-current-positions-and-explicit-manual-quotes',quoteSource:'saved-manual-price-with-recorded-time-not-live-market-feed',positions,byInstrument:INSTRUMENTS.map(instrument=>({instrument,...exposure(positions.filter(position=>position.instrument===instrument))})),estimatedEquity:realizedEquity===null||totals.unrealizedNetPnl===null?null:realizedEquity+totals.unrealizedNetPnl,riskMethod:'sum-of-saved-stop-hypothesis-risks',quantitiesAreNotAggregated:true};
    return {scope:'full-unified-account-all-instruments' as const,accountId:'legacy',currency:unified.currency,initialCapital:unified.capital,basisStart:settings.start,netPnl:sumConverted(periodEvents,settings,unified.currency),cumulativeNetPnl:fullNetPnl,realizedEquity,recordedCashBalance,paidUnallocatedEntryFees,paidUnallocatedEntryFeeCoverage,paidUnallocatedEntryFeeDetails,cashBalanceAsOf:end,cashBalanceBasis:'realized-equity-minus-actual-paid-unallocated-entry-fees',estimatedEquityBasis:'realized-equity-plus-net-unrealized-already-including-remaining-entry-fees',conversionComplete:fullNetPnl!==null,orderKnown,points,maxDrawdown:!orderKnown||!complete?null:Math.max(0,...points.map(point=>point.drawdown??0)),maxDrawdownPct:!orderKnown||!complete?null:Math.max(0,...points.map(point=>point.drawdownPct??0)),currentExposure,excludesUnrealized:true,capitalCount:1,ledgerUnitCorrection:unified.ledgerUnitCorrection??null};
  })();
  return {
    start, end, currency,basisStart:settings.start, selected, closed, tradeCount: selected.length, closedCount: closed.length, newTrades: selected.filter(t => t.openedDate !== null && t.openedDate >= start && t.openedDate <= end).length,
    netPnl, conversionComplete: netPnl !== null, currencyBuckets: buckets,
    missingConversions: events.filter(e => conversionRate(settings, e.currency, currency, e.date) === null).map(e => ({ tradeId: e.tradeId, date: e.date, from: e.currency, to: currency })),
    winRate: closed.length ? 100 * closed.filter(t => totalRealized(t) > 0).length / closed.length : null,
    grossProfit, grossLoss, profitFactor: grossProfit !== null && grossLoss !== null && grossLoss > 0 ? grossProfit / grossLoss : null,
    noLosingTrades: closed.length > 0 && completeOutcomes && grossLoss === 0,
    payoff: completeOutcomes && wins.length && losses.length ? mean(wins)! / -mean(losses)! : null,
    totalR: rs.length ? rs.reduce((s, n) => s + n, 0) : null, knownR: rs.length, averageR: mean(rs), expectancy: mean(rs),
    accountCurves, accountSummary, unifiedAccount:!!unified, ledgerUnitCorrection:unified?.ledgerUnitCorrection??null, maxDrawdown: accountCurves.length === 1 ? accountCurves[0].maxDrawdown : null, maxDrawdownPct: accountCurves.length === 1 ? accountCurves[0].maxDrawdownPct : null,
    ...streaks(closed), disciplineScore: mean(rated), disciplineCoverage: rated.length, disciplineMethod: '逐笔已明确评分：完全按计划100，部分偏离50，明显违规0；未知不计入',
    violations: selected.reduce((n, t) => n + executionViolations(t), 0), fomo: mean(fomo), fomoCoverage: fomo.length,
    fomoOutcomes: groupStats(t => t.fomo === true || (t.psychology?.fomo ?? 0) > 0 ? '有FOMO' : t.fomo === false || t.psychology?.fomo === 0 ? '无FOMO' : '未记录'),
    periods, models: groupStats(modelOf), frameworks: groupStats(frameworkOf), strategyModels: groupStats(t=>[instrumentOf(t),frameworkOf(t),modelOf(t)].join(' × ')), environments: groupStats(environmentOf), executionModes: groupStats(executionModeOf),
    research: groupStats(t => [instrumentOf(t), environmentOf(t), modelOf(t), executionModeOf(t)].join(' × ')),
    byInstrument: groupStats(t => instrumentOf(t)),
  };
}
