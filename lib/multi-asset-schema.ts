import { z } from 'zod';
import { contractSchema } from './g1-schema.ts';

export const INSTRUMENTS = ['XAU', 'NQ', 'BTC'] as const;
export type Instrument = typeof INSTRUMENTS[number];
export const instrumentSchema = z.enum(INSTRUMENTS);
export const currencySchema = z.string().regex(/^[A-Z][A-Z0-9]{1,11}$/, '请填写币种代码');
const text = z.string().max(200);
const amount = z.number().finite().positive().max(1e12).nullable();
const options = z.array(z.string().trim().min(1).max(100)).max(100).refine(v => new Set(v).size === v.length, '选项不能重复');
export const instrumentSettingsSchema = z.object({
  symbol: text.optional(), accountId: text.optional(), quoteSource: text.optional(), contract: contractSchema.optional(),
  models: options.optional(), environments: options.optional(), executionModes: options.optional(),
  riskLimit: amount.optional(), normalRisk: amount.optional(),
}).refine(v => v.riskLimit == null || v.normalRisk == null || v.normalRisk <= v.riskLimit, '常规风险不能超过风险上限');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => { const d = new Date(v + 'T00:00:00Z'); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v; }, '日期不存在');
export const multiAssetSettingsSchema = z.object({
  unifiedAccount: z.object({ enabled: z.boolean(), currency: z.literal('USD'), capital: z.number().finite().positive().max(1e12), ledgerUnitCorrection: z.object({ confirmed: z.boolean(), labels: z.array(currencySchema).min(1).max(20).refine(labels => new Set(labels).size === labels.length, '账本单位标签不能重复'), source: z.string().trim().min(1).max(1000) }).optional() }).optional(),
  instruments: z.object({ XAU: instrumentSettingsSchema.optional(), NQ: instrumentSettingsSchema.optional(), BTC: instrumentSettingsSchema.optional() }).optional(),
  accounts: z.array(z.object({ id: z.string().min(1).max(200), name: text, currency: currencySchema, capital: amount })).max(100).refine(v => new Set(v.map(a => a.id)).size === v.length, '账户编号不能重复').optional(),
  baseCurrency: currencySchema.optional(),
  fxRates: z.array(z.object({ from: currencySchema, to: currencySchema, rate: z.number().finite().positive().max(1e12), date, source: z.string().trim().min(1).max(500), confirmed: z.boolean() }).refine(v => v.from !== v.to, '换算币种必须不同')).max(10000).refine(v => new Set(v.map(r => [r.from, r.to, r.date].join(':'))).size === v.length, '同一日期的币种汇率不能重复').optional(),
});
export type MultiAssetSettings = z.infer<typeof multiAssetSettingsSchema>;
export type InstrumentSettings = z.infer<typeof instrumentSettingsSchema>;
