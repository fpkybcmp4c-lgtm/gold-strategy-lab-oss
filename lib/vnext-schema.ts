import { z } from 'zod';

export const FRAMEWORK_OPTIONS = [['G1', 'G1顺势交易'], ['independent', '非G1独立结构交易'], ['pending', '待确认']] as const;
export const STRUCTURE_OPTIONS = [['bull', '明确多头 HH/HL'], ['bear', '明确空头 LH/LL'], ['bull_to_bear', '多转空观察中'], ['bear_to_bull', '空转多观察中'], ['range', '震荡'], ['unknown', '无法判断']] as const;
export const REGIME_OPTIONS = [['trend_continuation', '趋势延续'], ['trend_pullback', '趋势回踩'], ['bear_continuation', '下跌中继'], ['bull_continuation', '上涨中继'], ['range', '震荡区间'], ['transition', '趋势转换'], ['repricing', '突破后重新定价'], ['unknown', '不确定']] as const;
export const VOLATILITY_OPTIONS = [['high', '高波动'], ['normal', '正常波动'], ['low', '低波动'], ['event', '事件驱动']] as const;
export const ENTRY_APPROACH_OPTIONS = [['early_lh_hl', '提前入场：LH/HL形成'], ['breakout_direct', '突破直接入场'], ['breakout_retest', '突破后回测确认'], ['double_top_bottom', '双顶/双底确认'], ['sweep_reclaim', '扫高/扫低后收回'], ['other', '其他']] as const;
export const LOCATION_OPTIONS = [['support', '重要支撑'], ['resistance', '重要阻力'], ['previous_high', '前高附近'], ['previous_low', '前低附近'], ['support_to_resistance', '支撑转阻力'], ['resistance_to_support', '阻力转支撑'], ['demand', '需求区'], ['supply', '供给区'], ['range_high', '区间上沿'], ['range_low', '区间下沿'], ['moving_average', '均线支撑/阻力'], ['other', '其他']] as const;
export const SETUP_STAGE_OPTIONS = [['candidate', '候选形成中'], ['at_location', '位置已到达'], ['waiting_trigger', '等待Trigger'], ['confirmed', 'Trigger确认'], ['invalidated', '结构失效']] as const;
export const TRIGGER_OPTIONS = [['lh', 'LH形成'], ['hl', 'HL形成'], ['bos', 'BOS确认'], ['choch', 'CHoCH确认'], ['close_breakout', '15m收盘突破'], ['accepted_closes', '连续收盘接受'], ['retest_failed', '突破回测失败'], ['retest_success', '突破回测成功'], ['double_top', '双顶确认'], ['double_bottom', '双底确认'], ['false_break_reclaim', '假突破后收回'], ['other', '其他']] as const;
export const CONFIRMATION_OPTIONS = [['confirmed', '已确认'], ['early', '尚未确认，提前入场'], ['partial', '部分确认'], ['unknown', '不确定']] as const;
export const INVALIDATION_OPTIONS = [['break_lh', '突破最近LH'], ['break_hl', '跌破最近HL'], ['return_range', '重新进入原区间'], ['breakout_failed', '突破失败'], ['retest_failed', '回测失败'], ['reverse_bos', '反向BOS'], ['zone_invalid', '关键区域失效'], ['other', '其他']] as const;
export const EMOTION_OPTIONS = [['calm', '平静'], ['stable', '情绪稳定'], ['overconfident', '过度自信'], ['confident', '自信'], ['excited', '兴奋'], ['anxious', '焦虑'], ['fearful', '恐惧'], ['fomo', 'FOMO'], ['recover_loss', '想回本'], ['urgent', '急于交易'], ['tired', '疲劳'], ['irritable', '烦躁'], ['neutral', '无明显情绪']] as const;
export const EXTERNAL_OPINION_OPTIONS = [['none', '未查看KOL'], ['viewed_unaffected', '查看但未影响计划'], ['changed_judgment', '查看后改变判断'], ['not_applicable', '不适用']] as const;
export const DISCIPLINE_OPTIONS = [['full', '完全按计划'], ['partial', '部分偏离'], ['violated', '明显违规']] as const;
export const DEVIATION_OPTIONS = [['unplanned_entry', '非计划入场'], ['frequent_reverse', '频繁反手'], ['early_entry', '提前入场'], ['direction_conflict', '方向冲突仍开仓'], ['risk_excess', '风险超限'], ['unplanned_add', '无计划加仓'], ['widened_stop', '止损扩大'], ['early_profit', '过早止盈'], ['immediate_reentry', '止损后立即重进'], ['trial_frequency', '非G1超出试行频次限制'], ['outside_session', '非交易时间开仓'], ['other', '其他']] as const;
export const CLOSE_REASON_OPTIONS = [['target', '达到止盈目标'], ['hard_stop', '触及硬止损'], ['structure_invalid', '结构失效'], ['support_holds', '关键支撑未破'], ['resistance_holds', '关键阻力未破'], ['reverse_bos', '出现反向BOS'], ['reverse_lh_hl', '出现反向LH/HL'], ['trend_change', '趋势转换'], ['rr_deteriorates', '风险收益恶化'], ['event_risk', '重要事件风险'], ['planned_profit', '计划内主动止盈'], ['time_end', '交易时间结束'], ['emotion_energy', '情绪或精力原因'], ['unplanned_early', '非计划提前退出'], ['other', '其他']] as const;

const option = <T extends string>(options: readonly (readonly [T, string])[]) => z.enum(options.map(item => item[0]) as [T, ...T[]]);
const positive = z.number().finite().positive().max(1e12).nullable();
const amount = z.number().finite().min(0).max(1e12).nullable();
const text = z.string().max(5000);
const at = z.string().datetime({ offset: true }).nullable();
const unique = <T extends z.ZodTypeAny>(schema: T, max: number) => z.array(schema).max(max).refine(values => new Set(values).size === values.length, '选项不能重复');

export const frameworkSchema = option(FRAMEWORK_OPTIONS);
export const closeReasonSchema = option(CLOSE_REASON_OPTIONS);
export const structureSchema = option(STRUCTURE_OPTIONS);
export const entrySnapshotSchema = z.object({
  capturedAt: at,
  source: z.enum(['entry', 'user-confirmed-history']).nullable(),
  framework: frameworkSchema.nullable().optional(),
  model: z.enum(['S1', 'S2', 'L1', 'L2', 'G1', '其他']).nullable().optional(),
  direction: z.enum(['long', 'short']).nullable().optional(),
  structure4H: structureSchema.nullable(), structure1H: structureSchema.nullable(), structure15m: structureSchema.nullable(),
  regime: option(REGIME_OPTIONS).nullable(), volatility: option(VOLATILITY_OPTIONS).nullable(),
  entryApproach: option(ENTRY_APPROACH_OPTIONS).nullable(),
  locations: unique(option(LOCATION_OPTIONS), LOCATION_OPTIONS.length), keyPrice: positive,
  setupStage: option(SETUP_STAGE_OPTIONS).nullable(), triggerTypes: unique(option(TRIGGER_OPTIONS), TRIGGER_OPTIONS.length),
  confirmation: option(CONFIRMATION_OPTIONS).nullable(), invalidationType: option(INVALIDATION_OPTIONS).nullable(), invalidationPrice: positive,
  notes: text,
});
export type EntrySnapshot = z.infer<typeof entrySnapshotSchema>;
export function blankEntrySnapshot(): EntrySnapshot {
  return { capturedAt: null, source: null, framework: null, model: null, direction: null, structure4H: null, structure1H: null, structure15m: null, regime: null, volatility: null, entryApproach: null, locations: [], keyPrice: null, setupStage: null, triggerTypes: [], confirmation: null, invalidationType: null, invalidationPrice: null, notes: '' };
}
export const observationSchema = entrySnapshotSchema.omit({ capturedAt: true, source: true, framework: true, model: true, direction: true }).extend({ id: z.string().min(1).max(200), observedAt: z.string().datetime({ offset: true }) });
export type MarketObservation = z.infer<typeof observationSchema>;

export const vnextPsychologyFields = {
  emotions: unique(option(EMOTION_OPTIONS), EMOTION_OPTIONS.length).optional(),
  externalOpinion: option(EXTERNAL_OPINION_OPTIONS).nullable().optional(),
  discipline: option(DISCIPLINE_OPTIONS).nullable().optional(),
  deviationReasons: unique(option(DEVIATION_OPTIONS), DEVIATION_OPTIONS.length).optional(),
};

const ruleBand = z.object({ normalMin: z.number().finite().positive(), normalMax: z.number().finite().positive(), hardLimit: z.number().finite().positive(), effectiveAt: at }).refine(rule => rule.normalMin <= rule.normalMax && rule.normalMax <= rule.hardLimit, '常规预算必须小于或等于硬上限');
export const riskRulesSchema = z.object({ version: z.string().min(1).max(100), currency: z.literal('USD').default('USD'), effectiveAt: at, G1: ruleBand, independent: ruleBand.and(z.object({ trialDays: z.number().int().min(0).max(90), noLossAddsDuringTrial: z.boolean() })) });
export type VNextRiskRules = z.infer<typeof riskRulesSchema>;
/** Default research rules; users must review before use. */
export const DEFAULT_VNEXT_RISK_RULES: VNextRiskRules = {
  version: 'VNext-1', currency: 'USD', effectiveAt: null,
  G1: { normalMin: 160, normalMax: 240, hardLimit: 400, effectiveAt: null },
  independent: { normalMin: 80, normalMax: 120, hardLimit: 200, effectiveAt: null, trialDays: 14, noLossAddsDuringTrial: true },
};
const contractSnapshotSchema = z.object({ confirmed: z.boolean(), usdPerPriceUnit: positive, entryFeePerQty: amount, exitFeePerQty: amount, slippagePrice: amount, quantityStep: positive, minimumQuantity: positive.optional(), currency: z.string().max(12).optional(),settlement:z.enum(['linear','inverse']).optional(),feeMode:z.enum(['perQuantity','notional']).optional(),entryFeeRate:amount.optional(),exitFeeRate:amount.optional(),feeCurrency:z.string().max(12).optional() });
export const riskRuleSnapshotSchema = z.object({
  capturedAt: z.string().datetime({ offset: true }), source: z.enum(['entry', 'user-confirmed-history']),
  framework: frameworkSchema, version: z.string().min(1).max(100), effectiveAt: at,
  ruleCurrency: z.string().regex(/^[A-Z][A-Z0-9]{1,11}$/, '风险快照币种无效').default('USD'),
  normalMin: amount, normalMax: amount, hardLimit: amount, approvedInitialRisk: amount,
  contract: contractSnapshotSchema, accountCurrency: z.string().max(12),
  priceRisk: amount, fees: amount, slippage: amount, totalRisk: amount,
  overNormalReason: text, trialDays: z.number().int().min(0).max(90), noLossAddsDuringTrial: z.boolean(),
}).refine(snapshot => snapshot.normalMin === null || snapshot.normalMax === null || snapshot.hardLimit === null || snapshot.normalMin <= snapshot.normalMax && snapshot.normalMax <= snapshot.hardLimit, '风险快照的预算区间无效');
export type RiskRuleSnapshot = z.infer<typeof riskRuleSnapshotSchema>;
export const historicalSupplementSchema = z.object({ confirmed: z.boolean(), evidence: z.enum(['pre-entry-record', 'user-memory', 'other']), sourceNote: text, fields: unique(z.enum(['framework', 'entrySnapshot', 'riskRuleSnapshot']), 3), confirmedAt: at });
export type HistoricalSupplement = z.infer<typeof historicalSupplementSchema>;
