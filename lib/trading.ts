import { z } from 'zod';
import { g1PlanSchema, psychologySchema, invalidationSchema, researchSchema, quoteSchema, contractSchema } from './g1-schema.ts';
import { MODELS, todayCN } from './domain.ts';
import { blankEntrySnapshot, closeReasonSchema, entrySnapshotSchema, frameworkSchema, historicalSupplementSchema, observationSchema, riskRuleSnapshotSchema } from './vnext-schema.ts';
import type { DailyRecord, Trade } from './domain.ts';
import { instrumentSchema } from './multi-asset-schema.ts';
import type { Instrument } from './multi-asset-schema.ts';

export const calendarDate=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>{const d=new Date(v+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===v;},'日期不存在');
const time=z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/);
export function executionTimeKey(date:string,time:string|null|undefined,fallback='00:00:00'){return date+'T'+(time?.length===5?time+':00':time??fallback);}
const positive=z.number().finite().positive().max(1e12).nullable();
const shortText=z.string().max(5000);
export const entrySchema=z.object({id:z.string().min(1).max(200),date:calendarDate,time:time.nullable(),quantity:z.number().finite().positive().max(1e12),price:z.number().finite().positive().max(1e12),fees:z.number().finite().min(0).max(1e9).nullable(),rationale:shortText,inPlan:z.boolean(),lossAdd:z.boolean().nullable(),feeSource:z.enum(['actual','estimated']).optional()});
export const closeSchema=z.object({id:z.string().min(1).max(200),date:calendarDate,time:time.nullable(),quantity:positive,price:positive,fees:z.number().finite().min(0).max(1e9).nullable(),netPnl:z.number().finite().min(-1e9).max(1e9),reason:shortText,reasons:z.array(closeReasonSchema).max(15).refine(values=>new Set(values).size===values.length,'平仓原因不能重复').optional(),primaryReason:closeReasonSchema.nullable().optional(),calculationMode:z.enum(['reported','automatic']).optional(),feeSource:z.enum(['actual','estimated']).optional(),otherCosts:z.number().finite().min(0).max(1e9).nullable().optional(),grossPnl:z.number().finite().nullable().optional(),allocatedEntryFee:z.number().finite().min(0).nullable().optional(),costsEstimated:z.boolean().optional()}).refine(close=>!close.primaryReason||!!close.reasons?.includes(close.primaryReason),'主要平仓原因必须包含在已选择的原因中');
export const positionEventSchema=z.object({id:z.string().min(1).max(200),date:calendarDate,time:time.nullable(),kind:z.enum(['stop','note']),stop:positive,note:shortText}).refine(e=>e.kind!=='stop'||e.stop!==null,'请填写真实的新止损价格');
export const lifecycleSchema=z.object({
  id:z.string().min(1).max(500),symbol:z.string().max(80).nullable(),openedDate:calendarDate.nullable(),openedTime:time.nullable(),
  instrument:instrumentSchema.optional(),accountId:z.string().max(200).optional(),quoteSource:z.string().max(200).optional(),researchModel:z.string().max(100).optional(),executionMode:z.string().max(100).optional(),
  direction:z.enum(['long','short']).nullable(),model:z.enum(MODELS),inPlan:z.boolean(),grade:z.enum(['A','B','其他']).nullable(),
  entryPrice:positive,quantity:positive,originalStop:positive,currentStop:positive,initialRisk:positive,targetPrice:positive,plannedRR:z.number().finite().min(0).max(1e5).nullable(),
  strategy:z.enum(['none','G1-L','G1-S']).optional(),recordType:z.enum(['executed','plan']).optional(),contract:contractSchema.optional(),aggregateEntryFee:z.number().finite().min(0).max(1e9).nullable().optional(),plannedRiskAtEntry:positive.optional(),entryPlan:z.array(z.object({id:z.string(),quantity:positive,price:positive,stop:positive,trigger:shortText})).max(100).optional(),
  framework:frameworkSchema.optional(),entrySnapshot:entrySnapshotSchema.optional(),riskRuleSnapshot:riskRuleSnapshotSchema.optional(),observations:z.array(observationSchema).max(1000).optional(),overNormalReason:shortText.optional(),historicalSupplement:historicalSupplementSchema.optional(),targetPrices:z.array(z.number().finite().positive().max(1e12)).max(3).optional(),
  status:z.enum(['open','partial','closed']),riskCompliant:z.boolean().nullable(),executionNote:shortText,
  environment:shortText,pattern:shortText,zones:shortText,trigger:shortText,invalidation:shortText,rationale:shortText,summary:shortText,
  fomo:z.boolean().nullable(),revenge:z.boolean().nullable(),emotional:z.boolean().nullable(),
  g1:g1PlanSchema.optional(),psychology:psychologySchema.optional(),invalidationRecord:invalidationSchema.optional(),research:researchSchema.optional(),manualQuote:quoteSchema.nullable().optional(),originalPlan:z.object({capturedAt:z.string(),data:z.record(z.string(),z.unknown())}).optional(),
  entries:z.array(entrySchema).max(1000).optional(),closes:z.array(closeSchema).max(1000),events:z.array(positionEventSchema).max(1000),
  legacy:z.object({dailyDate:calendarDate,tradeId:z.string().min(1).max(100),netPnl:z.number().finite().min(-1e9).max(1e9),detailed:z.boolean().optional()}).nullable(),
  revision:z.number().int().min(0),archived:z.boolean(),
}).passthrough().superRefine((t,ctx)=>{
  const issue=(message:string,path:string[]=['closes'])=>ctx.addIssue({code:z.ZodIssueCode.custom,message,path});
  if(t.recordType==='plan'&&((t.entries?.length??0)>0||t.closes.length>0))issue('计划单不能包含实际成交；请先切换为实际成交记录。',['recordType']);
  if(!t.legacy&&t.openedDate===null)issue('请填写开仓日期',['openedDate']);
  if(t.id.startsWith('daily:')||t.id.startsWith('opportunity:'))issue('交易ID不能使用每日截图的日期命名空间',['id']);
  const ids=[...(t.entries??[]).map(e=>e.id),...t.closes.map(c=>c.id),...t.events.map(e=>e.id)];if(new Set(ids).size!==ids.length)issue('开仓、平仓或持仓事件ID重复');
  if(t.entries?.length){
    const aggregate=entryTotals(t),epsilon=aggregate.quantity!*1e-8;
    if(t.quantity===null||Math.abs(t.quantity-aggregate.quantity!)>epsilon||t.entryPrice===null||Math.abs(t.entryPrice-aggregate.entryPrice!)>1e-7)issue('总数量与均价必须来自逐次开仓明细',['entries']);
    if(t.openedDate!==aggregate.openedDate||t.openedTime!==aggregate.openedTime)issue('开仓日期时间必须对应首笔成交',['entries']);
    const timeline=[...t.entries.map(e=>({key:executionTimeKey(e.date,e.time),q:e.quantity})),...t.closes.map(c=>({key:executionTimeKey(c.date,c.time,'23:59:59'),q:-(c.quantity??0)}))].sort((a,b)=>a.key.localeCompare(b.key)||b.q-a.q);
    let inventory=0;for(const e of timeline){inventory+=e.q;if(inventory < -epsilon){issue('平仓时累计数量超过当时已开仓数量',['closes']);break;}}
  }
  if(t.legacy&&!t.legacy.detailed){if(t.closes.length)issue('请先明确选择补全真实平仓明细，旧汇总不会自动拆分。');if(t.status!=='closed')issue('旧汇总交易必须保持全部平仓状态',['status']);return;}
  if(t.legacy?.detailed&&(!t.closes.length||t.status!=='closed'))issue('旧交易补全后需保留全部平仓状态及真实平仓明细');
  if(t.closes.some(c=>t.openedDate!==null&&c.date<t.openedDate))issue('平仓日期不能早于开仓日期');
  if(t.closes.some(c=>t.openedDate!==null&&c.date===t.openedDate&&t.openedTime!==null&&c.time!==null&&executionTimeKey(c.date,c.time)<executionTimeKey(t.openedDate,t.openedTime)))issue('平仓时间不能早于开仓时间');
  if(t.events.some(e=>t.openedDate!==null&&e.date<t.openedDate))issue('持仓更新不能早于开仓日期',['events']);
  if(t.quantity!==null){
    if(t.closes.some(c=>c.quantity===null))issue('已知开仓数量时，每次平仓数量必须填写');
    const closed=t.closes.reduce((s,c)=>s+(c.quantity??0),0),epsilon=t.quantity*1e-8;
    if(closed>t.quantity+epsilon)issue('累计平仓数量不能超过开仓数量');
    const expected=closed>=t.quantity-epsilon?'closed':closed>0?'partial':'open';
    if(t.status!==expected)issue('交易状态与累计平仓数量不一致',['status']);
  }else if((t.status==='closed'||t.status==='partial')&&!t.closes.length)issue('请先增加真实平仓记录；未平仓不能直接记作收益');
});
export type TradeRecord=z.infer<typeof lifecycleSchema>;
export type EntryEvent=z.infer<typeof entrySchema>;
export type CloseEvent=z.infer<typeof closeSchema>;
export type PositionEvent=z.infer<typeof positionEventSchema>;
export const TIMEFRAMES=['日线','4小时','1小时','15分钟','其他'] as const;
export const IMAGE_STAGES=['开仓前分析','分仓结构','持仓过程','平仓结果','最终复盘','每日市场观察'] as const;
export const imageMetaSchema=z.object({timeframe:z.enum(TIMEFRAMES),stage:z.enum(IMAGE_STAGES),caption:z.string().max(500)});
export type ImageMeta=z.infer<typeof imageMetaSchema>;
export type TradeImage=ImageMeta&{id:string;tradeId:string;entityType?:'trade'|'daily'|'opportunity';dailyDate?:string;opportunityId?:string;fileName:string;mime:string;size:number;createdAt:string;updatedAt:string};
export type HistoryEntry={id:string;entityType:'daily'|'trade'|'image'|'opportunity'|'settings';entityId:string;createdAt:string;changes:{field:string;before:unknown;after:unknown}[]};
export function timeCN(){return new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date());}
export function blankTrade(date=todayCN()):TradeRecord{return {id:crypto.randomUUID(),instrument:'XAU',symbol:'XAUUSDT.P',openedDate:date,openedTime:date===todayCN()?timeCN():null,direction:null,framework:'pending',entrySnapshot:blankEntrySnapshot(),observations:[],overNormalReason:'',targetPrices:[],model:'S1',inPlan:true,grade:null,entryPrice:null,quantity:null,originalStop:null,currentStop:null,initialRisk:null,targetPrice:null,plannedRR:null,status:'open',riskCompliant:null,executionNote:'',environment:'',pattern:'',zones:'',trigger:'',invalidation:'',rationale:'',summary:'',fomo:null,revenge:null,emotional:null,closes:[],events:[],legacy:null,revision:0,archived:false};}
export function legacyId(date:string,id:string){return 'legacy:'+date+':'+encodeURIComponent(id);}
export function legacyTrade(date:string,old:Trade):TradeRecord{return {...blankTrade(date),framework:undefined,entrySnapshot:undefined,observations:undefined,overNormalReason:undefined,targetPrices:undefined,id:legacyId(date,old.id),symbol:null,openedDate:null,openedTime:null,direction:null,model:old.model,inPlan:old.inPlan,initialRisk:old.initialRisk,status:'closed',legacy:{dailyDate:date,tradeId:old.id,netPnl:old.netPnl},executionNote:'旧日报汇总交易；开仓及逐次平仓明细未记录，保留为未知。'};}
export function compatibleTrades(days:DailyRecord[],stored:TradeRecord[]){
  const seen=new Set(stored.map(t=>t.id));const merged=[...stored];
  for(const d of days)for(const t of d.trades){const id=legacyId(d.date,t.id);if(!seen.has(id)){merged.push(legacyTrade(d.date,t));seen.add(id);}}
  return merged.sort((a,b)=>(b.openedDate??b.legacy?.dailyDate??'').localeCompare(a.openedDate??a.legacy?.dailyDate??''));
}
export function isLegacySummary(t:TradeRecord){return !!t.legacy&&!t.legacy.detailed;}
export function hasExecution(t:TradeRecord){if(t.recordType==='plan')return false;return !!t.entries?.length||t.quantity!==null&&t.entryPrice!==null||t.closes.length>0||isLegacySummary(t);}
export function totalRealized(t:TradeRecord){return isLegacySummary(t)?t.legacy!.netPnl:t.closes.reduce((s,c)=>s+c.netPnl,0);}
export function closedQuantity(t:TradeRecord){return t.closes.reduce((s,c)=>s+(c.quantity??0),0);}
export function entryTotals(t:TradeRecord){const entries=t.entries??[];if(!entries.length)return {quantity:t.quantity,entryPrice:t.entryPrice,openedDate:t.openedDate,openedTime:t.openedTime};const quantity=entries.every(e=>e.quantity>0&&e.price>0)?entries.reduce((s,e)=>s+e.quantity,0):null,first=[...entries].sort((a,b)=>executionTimeKey(a.date,a.time).localeCompare(executionTimeKey(b.date,b.time))||a.id.localeCompare(b.id))[0];return {quantity,entryPrice:quantity===null?null:entries.reduce((s,e)=>s+e.quantity*e.price,0)/quantity,openedDate:first.date,openedTime:first.time};}
export function syncStatus(t:TradeRecord):TradeRecord{const stop=[...t.events].filter(e=>e.kind==='stop'&&e.stop!==null).sort((a,b)=>executionTimeKey(a.date,a.time).localeCompare(executionTimeKey(b.date,b.time))).at(-1);if(stop)t={...t,currentStop:stop.stop};if(t.entries?.length)t={...t,...entryTotals(t)};if(isLegacySummary(t))return {...t,status:'closed'};if(t.quantity===null)return {...t,status:t.closes.length?(t.status==='closed'?'closed':'partial'):'open'};const n=closedQuantity(t),epsilon=t.quantity*1e-8;return {...t,status:n>=t.quantity-epsilon?'closed':n>0?'partial':'open'};}
export function orderedCloses(t:TradeRecord){return [...t.closes].sort((a,b)=>executionTimeKey(a.date,a.time,'23:59:59').localeCompare(executionTimeKey(b.date,b.time,'23:59:59'))||a.id.localeCompare(b.id));}
export function finalDate(t:TradeRecord){return isLegacySummary(t)?t.legacy!.dailyDate:(t.status==='closed'?orderedCloses(t).at(-1)?.date??null:null);}
export function fieldChanges(before:unknown,after:unknown){const a=(before??{}) as Record<string,unknown>,b=(after??{}) as Record<string,unknown>;return [...new Set([...Object.keys(a),...Object.keys(b)])].filter(k=>k!=='revision'&&JSON.stringify(a[k])!==JSON.stringify(b[k])).map(field=>({field,before:a[field]??null,after:b[field]??null}));}
export type TradeFilters={from:string;to:string;model:string;direction:string;plan:string;status:string;archived:boolean;instrument?:'all'|Instrument;accountId?:string};
export function instrumentOf(t:Pick<TradeRecord,'instrument'>):Instrument{return t.instrument??'XAU';}
export function filterTrades(trades:TradeRecord[],f:TradeFilters){return trades.filter(t=>t.archived===f.archived&&(!f.instrument||f.instrument==='all'||instrumentOf(t)===f.instrument)&&(!f.accountId||f.accountId==='all'||(t.accountId||(instrumentOf(t)==='XAU'?'legacy':`unassigned:${instrumentOf(t)}`))===f.accountId)&&(!f.from||(t.openedDate??t.legacy?.dailyDate??'')>=f.from)&&(!f.to||(t.openedDate??t.legacy?.dailyDate??'')<=f.to)&&(f.model==='all'||t.model===f.model||t.researchModel===f.model)&&(f.direction==='all'||t.direction===f.direction)&&(f.plan==='all'||t.inPlan===(f.plan==='yes'))&&(f.status==='all'||t.status===f.status));}

// Explicit framework classification; a saved G1 parameter block on an S1 trade is not membership.
export function g1Side(t:TradeRecord):'long'|'short'|null{if(t.framework==='pending'||t.framework==='independent')return null;if(t.framework==='G1')return t.direction;if(t.strategy==='G1-L')return 'long';if(t.strategy==='G1-S')return 'short';if(t.strategy==='none')return null;return t.model==='G1'&&t.direction==='short'?'short':null;}

export const tradeCurrency=(t:TradeRecord)=>t.contract?.currency??(instrumentOf(t)==='XAU'?t.g1?.contract?.currency??'USD':'UNKNOWN');
