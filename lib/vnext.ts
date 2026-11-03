import { maximumQuantity, riskSnapshot as remainingRiskSnapshot } from './g1.ts';
import { estimatedExecutionFee, linearContract, tradeContract } from './calculations.ts';
import type { Settings } from './domain.ts';
import type { TradeRecord } from './trading.ts';
import { hasExecution, instrumentOf } from './trading.ts';
import { accountConfig, accountOf, instrumentConfig, ledgerContract, ledgerCurrency, unifiedAccountConfig } from './multi-asset.ts';
import type { AssetRuleSnapshot } from './asset-policy.ts';
import { DEFAULT_VNEXT_RISK_RULES, riskRulesSchema } from './vnext-schema.ts';
import type { RiskRuleSnapshot } from './vnext-schema.ts';

const known = (value: number | null | undefined): value is number => value != null && Number.isFinite(value);
const positive = (value: number | null | undefined): value is number => known(value) && value > 0;
const money = (value: number) => Math.round((value + Number.EPSILON) * 1e8) / 1e8;
export function vnextFramework(trade: TradeRecord): 'G1' | 'independent' | 'pending' {
  if (trade.framework) return trade.framework;
  if (trade.strategy === 'G1-L' || trade.strategy === 'G1-S') return 'G1';
  if (trade.strategy === 'none') return 'independent';
  return 'pending';
}

export function currentEffectiveRules(settings: Settings) {
  const rules = settings.riskRules === undefined ? structuredClone(DEFAULT_VNEXT_RISK_RULES) : riskRulesSchema.parse(settings.riskRules);
  return { ...rules, G1: { ...rules.G1, effectiveAt: rules.G1.effectiveAt ?? settings.g1?.effectiveAt ?? null } };
}

/** No fabricated clock time when a historical entry only has a calendar date. */
export function entryDateTime(trade: TradeRecord) {
  if (!trade.openedDate || !trade.openedTime) return null;
  const value = Date.parse(trade.openedDate + 'T' + trade.openedTime + '+08:00');
  return Number.isFinite(value) ? new Date(value).toISOString() : null;
}
function appliesAt(date: string | null, time: string | null, effectiveAt: string | null, durationDays?: number) {
  if (!date || !effectiveAt) return null;
  const first = Date.parse(date + 'T' + (time ?? '00:00:00') + '+08:00');
  const last = time === null ? first + 86400000 - 1 : first;
  const effective = Date.parse(effectiveAt), end = durationDays === undefined ? Infinity : effective + durationDays * 86400000;
  if (!Number.isFinite(first) || !Number.isFinite(effective)) return null;
  if (last < effective || first >= end) return false;
  if (first >= effective && last < end) return true;
  return null;
}

/** Estimates complete hypothesis risk, including all layers and known plus expected costs. */
export function vnextRiskAssessment(trade: TradeRecord, settings: Settings, now = new Date()) {
  const asset = instrumentOf(trade), gold = asset === 'XAU', unified = unifiedAccountConfig(settings), assetConfig = instrumentConfig(settings, asset);
  const assetFrozen = trade.instrumentRiskSnapshot as AssetRuleSnapshot | undefined;
  const frozen = trade.riskRuleSnapshot, framework = frozen?.framework ?? vnextFramework(trade), rules = currentEffectiveRules(settings);
  const historicalAssetLimitsOnly = !gold && !frozen && !!assetFrozen && trade.revision > 0 && hasExecution(trade);
  const historicalNoRuleSnapshot = trade.revision > 0 && hasExecution(trade) && !frozen && !(assetFrozen && !gold);
  const band = framework === 'pending' ? null : framework === 'G1' ? rules.G1 : rules.independent;
  const sharedCurrent = gold || !!unified && !historicalAssetLimitsOnly;
  const normalMin = frozen ? frozen.normalMin : sharedCurrent ? band?.normalMin ?? null : null;
  const normalMax = frozen ? frozen.normalMax : historicalAssetLimitsOnly ? assetFrozen!.normalRisk : sharedCurrent ? band?.normalMax ?? null : assetFrozen ? assetFrozen.normalRisk : assetConfig.normalRisk;
  const hardLimit = frozen ? frozen.hardLimit : historicalAssetLimitsOnly ? assetFrozen!.riskLimit : sharedCurrent ? band?.hardLimit ?? null : assetFrozen ? assetFrozen.riskLimit : assetConfig.riskLimit;
  const effectiveAt = frozen?.effectiveAt ?? band?.effectiveAt ?? null;
  const contract = ledgerContract(frozen?.contract.confirmed ? frozen.contract : tradeContract(trade, settings), settings), currency = contract.currency ?? 'USD';
  const supportedContract=linearContract(contract)&&currency!=='UNKNOWN';
  const account = accountConfig(settings, accountOf(trade, settings));
  const rawRuleCurrency = frozen?.ruleCurrency ?? (historicalAssetLimitsOnly ? assetFrozen!.currency : sharedCurrent ? rules.currency : assetFrozen?.currency ?? assetConfig.contract.currency ?? 'UNKNOWN');
  const ruleCurrency = ledgerCurrency(rawRuleCurrency, settings);
  const accountCurrency = unified ? unified.currency : gold && accountOf(trade, settings) === 'legacy' ? settings.accountCurrency ?? 'USD' : account?.currency;
  const accountCurrencyMismatch = !accountCurrency || currency !== accountCurrency;
  const ruleCurrencyMismatch = currency === 'UNKNOWN' || currency !== ruleCurrency;
  const currencyMismatch = accountCurrencyMismatch || ruleCurrencyMismatch;
  const layers = trade.entryPlan?.length ? trade.entryPlan : positive(trade.quantity) && positive(trade.entryPrice) ? [{ id: 'aggregate', quantity: trade.quantity, price: trade.entryPrice, stop: trade.originalStop, trigger: '' }] : [];
  const layersReady = layers.length > 0 && trade.direction !== null && layers.every(layer => positive(layer.quantity) && positive(layer.price) && positive(layer.stop) && (trade.direction === 'short' ? layer.stop - layer.price : layer.price - layer.stop) > 0);
  const quantity = layersReady ? layers.reduce((sum, layer) => sum + layer.quantity!, 0) : null;
  const priceRisk = supportedContract && layersReady && contract.confirmed && positive(contract.usdPerPriceUnit) ? money(layers.reduce((sum, layer) => sum + (trade.direction === 'short' ? layer.stop! - layer.price! : layer.price! - layer.stop!) * layer.quantity! * contract.usdPerPriceUnit!, 0)) : null;
  // Unexecuted costs are projections at the saved layer prices. Partial exits use
  // the same proportional allocation as the moving-average inventory.
  const projectedFees=(side:'entry'|'exit',qty:number|null,atTarget=false):number|null=>{
    if(!supportedContract||quantity===null||qty===null)return null;
    if(qty===0)return 0;
    const values=layers.map(layer=>estimatedExecutionFee(contract,layer.quantity!*qty/quantity,atTarget?trade.targetPrice:side==='entry'?layer.price:layer.stop,side));
    return values.every((v):v is number=>v!==null)?money(values.reduce((n,v)=>n+v,0)):null;
  };
  const executedEntryQuantity = (trade.entries ?? []).reduce((sum, entry) => sum + entry.quantity, 0);
  const knownEntryFees = trade.entries?.length && trade.entries.every(entry => known(entry.fees)) ? trade.entries.reduce((sum, entry) => sum + entry.fees!, 0) : null;
  const futureEntryQuantity = quantity === null ? null : Math.max(0, quantity - executedEntryQuantity);
  const projectedEntryFee=projectedFees('entry',futureEntryQuantity);
  const entryFees = knownEntryFees !== null ? futureEntryQuantity === null ? null : futureEntryQuantity === 0 ? knownEntryFees : projectedEntryFee!==null ? money(knownEntryFees+projectedEntryFee) : null : trade.aggregateEntryFee ?? projectedFees('entry',quantity);
  const closedQuantity = trade.closes.reduce((sum, close) => sum + (close.quantity ?? 0), 0);
  const closeFeeKnown = trade.closes.every(close => known(close.fees));
  const remainingExitQuantity = quantity === null ? null : Math.max(0, quantity - closedQuantity);
  const projectedExitFee=projectedFees('exit',remainingExitQuantity);
  const exitFees = quantity === null ? null : closeFeeKnown && remainingExitQuantity === 0 ? trade.closes.reduce((sum, close) => sum + close.fees!, 0) : closeFeeKnown && projectedExitFee!==null ? money(trade.closes.reduce((sum, close) => sum + close.fees!, 0)+projectedExitFee) : projectedFees('exit',quantity);
  const otherCosts = trade.closes.reduce((sum, close) => sum + (close.otherCosts ?? 0), 0);
  const fees = entryFees !== null && exitFees !== null ? money(entryFees + exitFees + otherCosts) : null;
  const slippage = supportedContract && quantity !== null && contract.confirmed && positive(contract.usdPerPriceUnit) && known(contract.slippagePrice) ? money(quantity * contract.slippagePrice * contract.usdPerPriceUnit) : null;
  const totalRisk = priceRisk !== null && fees !== null && slippage !== null ? money(priceRisk + fees + slippage) : null;
  const remaining = remainingRiskSnapshot({ ...trade, contract }, settings);
  const remainingRisk = remaining.hypothesisRisk;
  const amounts = [totalRisk, trade.initialRisk].filter((value): value is number => known(value));
  const riskAmount = amounts.length ? Math.max(...amounts) : null;
  const overNormal = historicalNoRuleSnapshot || currencyMismatch || normalMax === null ? null : known(riskAmount) ? riskAmount > normalMax + 1e-8 || remainingRisk !== null && remainingRisk > normalMax + 1e-8 : remainingRisk === null ? null : remainingRisk > normalMax + 1e-8;
  const overHard = historicalNoRuleSnapshot || currencyMismatch || hardLimit === null ? null : known(riskAmount) ? riskAmount > hardLimit + 1e-8 || remainingRisk !== null && remainingRisk > hardLimit + 1e-8 : remainingRisk === null ? null : remainingRisk > hardLimit + 1e-8;
  const requiresReason = overNormal === true && overHard !== true && !trade.overNormalReason?.trim();
  const trialDays = frozen?.trialDays ?? (framework === 'independent' ? rules.independent.trialDays : 0);
  const noLossAddsDuringTrial = frozen?.noLossAddsDuringTrial ?? (framework === 'independent' && rules.independent.noLossAddsDuringTrial);
  const trialEnd = effectiveAt === null ? null : new Date(Date.parse(effectiveAt) + trialDays * 86400000).toISOString();
  const trialActive = framework !== 'independent' ? false : effectiveAt === null ? null : now.getTime() >= Date.parse(effectiveAt) && now.getTime() < Date.parse(trialEnd!);
  const lossAddChecks = (trade.entries ?? []).filter(entry => entry.lossAdd === true).map(entry => ({ id: entry.id, active: framework === 'independent' && noLossAddsDuringTrial ? appliesAt(entry.date, entry.time, effectiveAt, trialDays) : false }));
  const trialViolationIds = historicalNoRuleSnapshot || historicalAssetLimitsOnly ? [] : lossAddChecks.filter(check => check.active === true).map(check => check.id);
  const riskCompliant = historicalNoRuleSnapshot ? null : overHard === true || trialViolationIds.length > 0 ? false : framework === 'pending' || totalRisk === null || overHard === null || requiresReason ? null : true;
  const target = trade.targetPrice, entry = trade.entryPrice;
  const targetDistance = positive(entry) && positive(target) && trade.direction !== null ? trade.direction === 'short' ? entry - target : target - entry : null;
  const targetGross = supportedContract && quantity !== null && targetDistance !== null && targetDistance > 0 && contract.confirmed && positive(contract.usdPerPriceUnit) ? targetDistance * quantity * contract.usdPerPriceUnit : null;
  const targetExitFees=projectedFees('exit',quantity,true);
  const targetNet = targetGross !== null && entryFees !== null && targetExitFees!==null && slippage !== null ? money(targetGross - entryFees-targetExitFees-otherCosts-slippage) : null;
  return {
    framework, currency, ruleCurrency, rawRuleCurrency, currencyMismatch, accountCurrencyMismatch, ruleCurrencyMismatch, ready: totalRisk !== null, totalRisk, approvedRisk: totalRisk, priceRisk, entryFees, exitFees, fees, slippage,
    normalMin, normalMax, hardLimit, effectiveAt, ruleVersion: frozen?.version ?? rules.version,
    riskSource: frozen ? 'saved-entry-rule-snapshot' : historicalAssetLimitsOnly ? 'saved-instrument-entry-rules' : historicalNoRuleSnapshot ? 'legacy-no-rule-snapshot' : gold ? 'current-effective-rules' : 'current-instrument-limits-shared-framework', limitsAreCurrentReferenceOnly: historicalNoRuleSnapshot, ruleAppliesToEntry: appliesAt(trade.openedDate, trade.openedTime, effectiveAt),
    overNormal, overHard, requiresReason, riskCompliant,
    planAllowed: totalRisk !== null && framework !== 'pending' && overHard === false && !requiresReason && !trialViolationIds.length,
    riskPct: totalRisk === null || currencyMismatch || !account?.capital ? null : 100 * totalRisk / account.capital,
    maximum: normalMax === null || currencyMismatch ? null : maximumQuantity(entry, trade.originalStop, trade.direction, normalMax, contract),
    grossRR: targetGross !== null && priceRisk !== null && priceRisk > 0 ? targetGross / priceRisk : null,
    netRR: targetNet !== null && totalRisk !== null && totalRisk > 0 ? targetNet / totalRisk : null,
    remainingRisk, openPositionRisk: remaining.openRisk,
    feesEstimated: knownEntryFees === null && trade.aggregateEntryFee == null || !!trade.entries?.some(entry => entry.feeSource === 'estimated') || !closeFeeKnown || quantity !== null && closedQuantity < quantity,
    trial: { effectiveAt: framework === 'independent' ? effectiveAt : null, durationDays: trialDays, endAt: framework === 'independent' ? trialEnd : null, active: historicalNoRuleSnapshot || historicalAssetLimitsOnly ? null : trialActive, prohibitsLossAdd: !historicalNoRuleSnapshot && !historicalAssetLimitsOnly && trialActive === true && noLossAddsDuringTrial, violatingEntryIds: trialViolationIds, dateUnknownEntryIds: historicalAssetLimitsOnly ? [] : lossAddChecks.filter(check => check.active === null).map(check => check.id), evaluation: historicalAssetLimitsOnly ? 'unknown-no-shared-entry-rule-snapshot' : historicalNoRuleSnapshot ? 'unknown-no-entry-rule-snapshot' : frozen ? 'saved-entry-rules' : 'current-rules' },
  };
}

/** Captures entry-time adoption only; editing an earlier historical trade never backfills new rules. */
export function captureRiskRuleSnapshot(trade: TradeRecord, settings: Settings, now = new Date()): RiskRuleSnapshot | undefined {
  const assessment = vnextRiskAssessment({ ...trade, riskRuleSnapshot: undefined, revision: 0 }, settings, now);
  if (assessment.framework === 'pending' || assessment.ruleAppliesToEntry !== true || assessment.currencyMismatch) return undefined;
  const rules = currentEffectiveRules(settings), independent = assessment.framework === 'independent';
  return {
    capturedAt: now.toISOString(), source: 'entry', framework: assessment.framework, version: rules.version, effectiveAt: assessment.effectiveAt, ruleCurrency: assessment.ruleCurrency,
    normalMin: assessment.normalMin, normalMax: assessment.normalMax, hardLimit: assessment.hardLimit,
    approvedInitialRisk: assessment.overHard === true || assessment.requiresReason ? null : assessment.totalRisk,
    contract: structuredClone(ledgerContract(tradeContract(trade, settings), settings)), accountCurrency: accountConfig(settings, accountOf(trade, settings))?.currency ?? 'UNKNOWN',
    priceRisk: assessment.priceRisk, fees: assessment.fees, slippage: assessment.slippage, totalRisk: assessment.totalRisk,
    overNormalReason: trade.overNormalReason ?? '', trialDays: independent ? rules.independent.trialDays : 0, noLossAddsDuringTrial: independent && rules.independent.noLossAddsDuringTrial,
  };
}
