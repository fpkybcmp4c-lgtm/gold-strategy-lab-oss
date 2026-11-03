import { z } from 'zod';
import { g1SettingsSchema } from './g1-schema.ts';
import { wellbeingSchema } from './wellbeing-schema.ts';
import { riskRulesSchema } from './vnext-schema.ts';
import type { VNextRiskRules } from './vnext-schema.ts';
import { multiAssetSettingsSchema, currencySchema } from './multi-asset-schema.ts';
import type { MultiAssetSettings } from './multi-asset-schema.ts';
export const DEFAULT_SETTINGS = { start: '2026-01-01', end: '2026-03-31', capital: 10000, riskLimit: 500, targetDiscipline: 85, minTrades: 30 };
export const MODELS = ['S1', 'S2', 'L1', 'L2', 'G1', '其他'] as const;
export const ENVIRONMENTS = ['明确上涨', '明确下跌', '窄幅震荡', '宽幅混乱', '无趋势'] as const;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '请输入有效日期').refine(v => { const d = new Date(v + 'T00:00:00Z'); return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10) === v; }, '日期不存在');
const count = z.number().int().min(0).max(10000);
const money = z.number().finite().min(-1e9).max(1e9);
export const tradeSchema = z.object({ id: z.string().min(1).max(100), model: z.enum(MODELS), netPnl: money, initialRisk: z.number().finite().positive().max(1e7).nullable(), inPlan: z.boolean() });
const dailyFields = z.object({
  date, environment: z.enum(ENVIRONMENTS), pattern: z.string().max(5000), aOpportunity: z.boolean(), newTrades: count, openPositions: count,
  planCompliant: z.boolean(), violations: count, riskCompliant: z.boolean(), fomo: z.number().int().min(0).max(10), impulses: count, resisted: count,
  screenMinutes: z.number().int().min(0).max(1440), intradayDrawdown: z.number().finite().min(0).max(1e9).nullable(), note: z.string().max(5000), trades: z.array(tradeSchema).max(100),
  wellbeing: wellbeingSchema.optional(),disciplineAssessed:z.boolean().optional(),fomoRecorded:z.boolean().optional(),quick:z.object({market:z.enum(['up','down','range','transition','uncertain']).nullable(),structures:z.array(z.string().max(40)).max(20),opportunity:z.enum(['A','normal','none','unknown']).nullable(),discipline:z.enum(['full','partial','broken','noTrade','unrated']).nullable(),emotions:z.array(z.string().max(40)).max(20),energy:z.enum(['high','normal','low','poor']).nullable(),noTrade:z.boolean()}).optional(),
  marketState:z.enum(['trend','range','transition']).nullable().optional(),oneHourTrend:z.string().max(5000).optional(),zones:z.string().max(5000).optional(),marketHypothesis:z.string().max(5000).optional(),macroInfo:z.string().max(5000).optional(),
  dailyTrend:z.string().max(5000).optional(),fourHourTrend:z.string().max(5000).optional(),plannedDirection:z.enum(['long','short','observe']).nullable().optional(),marketPlan:z.string().max(5000).optional(),
});
export const dailyDraftSchema=dailyFields.passthrough();
export const dailySchema = dailyDraftSchema.superRefine((v, ctx) => {
  if (v.planCompliant && (v.violations > 0 || v.impulses > 0 || v.trades.some(t => !t.inPlan))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['planCompliant'], message: '有违规、冲动交易或非计划平仓单时，请选择“未遵守计划”。' });
  if (new Set(v.trades.map(t=>t.id)).size !== v.trades.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path:['trades'], message:'交易编号重复' });
  if ((v.wellbeing?.violationContexts?.length ?? 0) > v.violations) ctx.addIssue({ code: z.ZodIssueCode.custom, path:['wellbeing','violationContexts'], message:'违规时间补充不能超过已填写的违规次数。' });
});
export const settingsSchema = z.object({ start: date, end: date, capital: z.number().finite().positive().max(1e9), riskLimit: z.number().finite().positive().max(1e7), targetDiscipline: z.number().int().min(0).max(100), minTrades: z.number().int().min(1).max(10000), g1:g1SettingsSchema.optional(),accountCurrency:currencySchema.optional(),riskRules:riskRulesSchema.optional(),multiAsset:multiAssetSettingsSchema.optional() }).passthrough().refine(v => v.end >= v.start && dayDistance(v.start,v.end) <= 366, '结束日期需晚于开始日期，且区间不得超过一年');
export type DailyRecord = Omit<z.infer<typeof dailyFields>,'trades'> & {trades:Trade[];hasDailyState?:boolean;reportedNewTrades?:number;reportedOpenPositions?:number;tradeRisks?:(number|null)[];[key:string]:unknown};
export type Settings = {start:string;end:string;capital:number;riskLimit:number;targetDiscipline:number;minTrades:number;g1?:z.infer<typeof g1SettingsSchema>;accountCurrency?:string;riskRules?:VNextRiskRules;multiAsset?:MultiAssetSettings;[key:string]:unknown};
export type Trade = z.infer<typeof tradeSchema> & {partial?:boolean;tradeNetPnl?:number;rPnl?:number;lifecycleId?:string;closeEvent?:boolean};
export type Granularity = 'day' | 'week' | 'month';
export const moneyFormat = (n: number, decimals = 0) => new Intl.NumberFormat('en-US', { maximumFractionDigits: decimals, minimumFractionDigits: decimals }).format(n);
export function todayCN() { return new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date()); }
export function addDays(date: string, days: number) { const d = new Date(date+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+days); return d.toISOString().slice(0,10); }
export function dayDistance(a: string,b: string) { return Math.round((new Date(b+'T00:00:00Z').getTime()-new Date(a+'T00:00:00Z').getTime())/86400000); }
export function blankDay(date = todayCN()): DailyRecord { return { date, environment:'明确下跌', pattern:'', aOpportunity:false, newTrades:0, openPositions:0, planCompliant:true, violations:0, riskCompliant:true, fomo:0, impulses:0, resisted:0, screenMinutes:0, intradayDrawdown:null, note:'', trades:[] }; }
export function discipline(d: DailyRecord, riskLimit = 500) {
  const evidence=d.executionDiscipline as {riskViolation?:boolean;planDeviation?:boolean;minimumViolations?:number}|undefined;
  const safeRisk = d.riskCompliant && !evidence?.riskViolation && (d.tradeRisks??d.trades.map(t=>t.initialRisk)).every(r => r === null || r <= riskLimit);
  const violations=Math.max(d.violations,evidence?.minimumViolations??0);
  return (d.planCompliant&&!evidence?.planDeviation ? 40 : 0) + (safeRisk ? 25 : 0) + Math.max(0,20-5*violations) + Math.max(0,15-5*d.impulses);
}
export function assessedDiscipline(d:DailyRecord,riskLimit=500){return d.hasDailyState===false||d.disciplineAssessed===false?null:discipline(d,riskLimit);}
export function effectivePlanCompliance(d:DailyRecord){const e=d.executionDiscipline as {riskViolation?:boolean;planDeviation?:boolean}|undefined;return d.planCompliant&&!e?.riskViolation&&!e?.planDeviation;}
export const pnl = (d: DailyRecord) => d.trades.reduce((s,t)=>s+t.netPnl,0);
export const riskR = (t: Trade) => t.partial||t.initialRisk===null||!Number.isFinite(t.initialRisk)||t.initialRisk<=0 ? null : (t.rPnl??t.netPnl)/t.initialRisk;
export function recordR(d: DailyRecord) { const known=d.trades.filter(t=>riskR(t)!==null); return known.length ? known.reduce((s,t)=>s+Number(riskR(t)),0) : null; }
export type EquityPoint = DailyRecord & { dailyPnl:number; cumulative:number; equity:number; drawdown:number; drawdownPct:number; score:number|null };
export function equitySeries(records:DailyRecord[], settings:Settings):EquityPoint[] {
  let cumulative=0, peak=settings.capital;
  return records.filter(d=>d.date>=settings.start && d.date<=settings.end).sort((a,b)=>a.date.localeCompare(b.date)).map(d=>{
    cumulative+=pnl(d); const equity=settings.capital+cumulative; peak=Math.max(peak,equity); const drawdown=Math.max(0,peak-equity);
    return {...d,dailyPnl:pnl(d),cumulative,equity,drawdown,drawdownPct:peak>0?100*drawdown/peak:0,score:assessedDiscipline(d,settings.riskLimit)};
  });
}
export type Filters = { start:string; end:string; compliance:'all'|'yes'|'no'; model:string };
export function filterRecords<T extends DailyRecord>(records:T[], filters:Filters):T[] {
  return records.filter(d=>d.date>=filters.start && d.date<=filters.end && (filters.compliance==='all' || d.hasDailyState!==false&&d.disciplineAssessed!==false&&effectivePlanCompliance(d)===(filters.compliance==='yes')) && (filters.model==='all' || d.trades.some(t=>t.model===filters.model)));
}
export function summarize(records:DailyRecord[],settings:Settings, points?:EquityPoint[]) {
  const events=records.flatMap(d=>d.trades),trades=events.filter(t=>!t.partial),states=records.filter(d=>d.hasDailyState!==false),rated=states.filter(d=>assessedDiscipline(d,settings.riskLimit)!==null),fomoStates=states.filter(d=>d.fomoRecorded!==false),known=trades.filter(t=>riskR(t)!==null),rs=known.map(t=>Number(riskR(t)));
  const outcome=(t:Trade)=>t.tradeNetPnl??t.netPnl;
  const grossProfit=trades.reduce((s,t)=>s+Math.max(0,outcome(t)),0), grossLoss=-trades.reduce((s,t)=>s+Math.min(0,outcome(t)),0);
  const series=points??equitySeries(records,settings);
  const totalPnl=events.reduce((s,t)=>s+t.netPnl,0), totalR=rs.reduce((s,r)=>s+r,0);
  return { days:states.length, trades:trades.length, knownR:known.length, totalPnl, totalR:known.length?totalR:null, expectancy:known.length?totalR/known.length:null,newTrades:records.reduce((s,d)=>s+d.newTrades,0),partialEvents:events.filter(t=>t.partial&&t.closeEvent).length,closeEvents:events.filter(t=>t.closeEvent).length,legacySummaries:events.filter(t=>!t.closeEvent).length,
    profitFactor:grossLoss>0?grossProfit/grossLoss:grossProfit>0?Infinity:null, grossProfit,grossLoss,
    winRate:trades.length?100*trades.filter(t=>outcome(t)>0).length/trades.length:null,
    score:rated.length?rated.reduce((s,d)=>s+discipline(d,settings.riskLimit),0)/rated.length:null,disciplineCoverage:rated.length,
    complianceRate:rated.length?100*rated.filter(effectivePlanCompliance).length/rated.length:null,
    violations:states.reduce((s,d)=>s+d.violations,0), impulses:states.reduce((s,d)=>s+d.impulses,0), resisted:states.reduce((s,d)=>s+d.resisted,0),
    fomo:fomoStates.length?fomoStates.reduce((s,d)=>s+d.fomo,0)/fomoStates.length:null,
    maxDrawdown:Math.max(0,...series.map(d=>d.drawdown)), maxDrawdownPct:Math.max(0,...series.map(d=>d.drawdownPct)),
    maxReportedDD:states.some(d=>d.intradayDrawdown!==null)?Math.max(...states.map(d=>d.intradayDrawdown??0)):null,
    inPlanTrades:trades.filter(t=>t.inPlan).length, inPlanPnl:events.filter(t=>t.inPlan).reduce((s,t)=>s+t.netPnl,0),
    offPlanPnl:events.filter(t=>!t.inPlan).reduce((s,t)=>s+t.netPnl,0), screenMinutes:states.reduce((s,d)=>s+d.screenMinutes,0),
  };
}
export function periodKey(date:string, granularity:Granularity) {
  if(granularity==='day')return date;
  if(granularity==='month')return date.slice(0,7);
  const d=new Date(date+'T00:00:00Z'); return addDays(date,-((d.getUTCDay()+6)%7));
}
export function aggregate(points:EquityPoint[],settings:Settings,granularity:Granularity) {
  const map=new Map<string,EquityPoint[]>();
  for(const d of points){ const k=periodKey(d.date,granularity); map.set(k,[...(map.get(k)??[]),d]); }
  return Array.from(map.entries()).sort((a,b)=>a[0].localeCompare(b[0])).map(([key,days])=>({ key, label:granularity==='week'?key.slice(5)+' 当周':granularity==='month'?key.slice(0,4)+'年'+Number(key.slice(5))+'月':key.slice(5), ...summarize(days,settings,days), cumulative:days.at(-1)!.cumulative, drawdown:Math.max(...days.map(d=>d.drawdown)), intradayDrawdown:days.some(d=>d.intradayDrawdown!==null)?Math.max(...days.map(d=>d.intradayDrawdown??0)):null }));
}
export function evaluation(records:DailyRecord[],settings:Settings) {
  const stats=summarize(records,settings), planned=records.flatMap(d=>d.trades).filter(t=>t.inPlan&&riskR(t)!==null);
  const e=planned.length?planned.reduce((s,t)=>s+Number(riskR(t)),0)/planned.length:null;
  const sufficient=planned.length>=settings.minTrades;
  const disciplined=stats.score!==null&&stats.score>=settings.targetDiscipline;
  let title='等待真实样本',tone='neutral',body='完成每日记录，先检验你是否稳定执行同一套模型。';
  if(stats.trades){
    if(!sufficient){title='继续收集样本';body=`计划内且风险明确的平仓单为 ${planned.length} 笔，当前参考门槛为 ${settings.minTrades} 笔，暂不判定长期有效。`;}
    else if(!disciplined){title='优先修复执行';tone='warning';body='纪律评分尚未达参考门槛。先降低违规与冲动交易，再评估策略本身。';}
    else if(e!==null&&e>0){title='出现正期望迹象';tone='positive';body='计划内样本的平均 R 为正，且执行较稳定。仍需完成整个验证期，并观察后续样本与回撤。';}
    else {title='需要检查模型';tone='warning';body='执行较稳定，但计划内样本的平均 R 未为正。复查入场、退出和市场环境的匹配。';}
  }
  return { title,tone,body,plannedCount:planned.length,plannedExpectancy:e,sufficient,disciplined };
}
export function generateDemo():DailyRecord[]{
  const records:DailyRecord[]=[];
  const outcomes=[1.8,-1,0.4,2.2,-0.7,1.1,-1,0.6,2.6,-0.8];
  for(let i=0;i<92;i+=2){
    const date=addDays(DEFAULT_SETTINGS.start,i), bad=i%14===6, noTrade=i%12===0;
    const d=blankDay(date); Object.assign(d,{environment:i%8<4?'明确下跌':'明确上涨',pattern:i%8<4?'供应区二次冲高失败':'需求区回踩后形成 HL',aOpportunity:!noTrade,newTrades:noTrade?0:bad?3:1,planCompliant:!bad||noTrade,violations:bad&&!noTrade?2:0,impulses:bad&&!noTrade?1:0,fomo:bad?8:2+i%4,resisted:i%3,screenMinutes:noTrade?20:45+i%60,intradayDrawdown:noTrade?0:bad?480:120+(i%4)*40,note:noTrade?'没有明确的一小时信号，空仓遵守计划。':bad?'晚间因怕踏空提前进场，复盘后明确等待确认。':'按模型执行；到第一验证位减仓，剩余仓位依结构管理。'});
    if(!noTrade){const n=bad?3:1;for(let j=0;j<n;j++){const netPnl=bad?[-160,-240,80][j]:Math.round(outcomes[(i/2)%outcomes.length]*200);d.trades.push({id:`demo-${i}-${j}`,model:bad?'其他':i%8<4?(i%4?'S1':'S2'):(i%4?'L1':'L2'),netPnl,initialRisk:i===10?null:j===1?240:200,inPlan:!bad});}}
    records.push(d);
  }
  return records;
}
