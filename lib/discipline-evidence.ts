import type { TradeRecord } from './trading.ts';

export type ExecutionEvidence={tradeId:string;key:string;date:string|null;reason:string;risk:boolean;plan:boolean;source:'saved-trade-or-event'};
/** Only recorded facts are evidence. Emotions, profits and current risk settings are not rules. */
export function tradeDisciplineEvidence(trade:TradeRecord):ExecutionEvidence[]{
  if(trade.archived||trade.recordType==='plan')return [];
  const first=[...(trade.entries??[])].sort((a,b)=>(a.date+'T'+(a.time??'')).localeCompare(b.date+'T'+(b.time??'')))[0];
  const date=first?.date??trade.openedDate??trade.legacy?.dailyDate??null;
  const result:ExecutionEvidence[]=[];
  const add=(key:string,reason:string,risk=false,plan=true,at=date)=>result.push({tradeId:trade.id,key:trade.id+':'+key,date:at,reason,risk,plan,source:'saved-trade-or-event'});
  if(trade.riskCompliant===false)add('risk','已保存风险不合规',true,false);
  if(!trade.inPlan)add('off-plan','已保存计划外交易');
  for(const entry of trade.entries??[]){if(!entry.inPlan)add('entry:'+entry.id,'已保存计划外加仓',false,true,entry.date);if(entry.lossAdd===true)add('loss-add:'+entry.id,'已保存亏损违规补仓',true,true,entry.date);}
  const p=trade.psychology,i=trade.invalidationRecord;
  if(p?.discipline==='partial'||p?.discipline==='violated')add('discipline','交易纪律自评偏离或违规');
  if(p?.deviationReasons?.length)add('deviations','已保存偏离原因：'+p.deviationReasons.join(' / '),p.deviationReasons.includes('risk_excess'));
  if(p?.stopChangedWithoutPlan===true||i?.widenedStop===true)add('stop','已保存擅自修改或扩大止损',true,true,i?.date??date);
  if(i?.heldAfterInvalidation===true)add('invalid-held','已保存结构失效后继续持有',false,true,i.date??date);
  if(i?.immediateReverse===true&&i.independentSetup===false)add('reverse','已保存止损后无独立Setup反手',false,true,i.date??date);
  if(trade.revenge===true)add('revenge','已保存报复交易');
  const rule=trade.riskRuleSnapshot;
  if(rule?.hardLimit!=null&&trade.initialRisk!=null&&(trade.contract?.currency??'USD')===rule.ruleCurrency&&trade.initialRisk>rule.hardLimit)add('snapshot-hard','保存的初始风险超过入场规则硬上限',true,false);
  return result;
}
export function dailyDisciplineEvidence(trades:TradeRecord[],date:string){
  const evidence=[...new Map(trades.flatMap(tradeDisciplineEvidence).filter(item=>item.date===date).map(item=>[item.key,item])).values()];
  return {riskViolation:evidence.some(item=>item.risk),planDeviation:evidence.some(item=>item.plan),minimumViolations:new Set(evidence.map(item=>item.tradeId)).size,evidence,source:'saved-trades-and-events',dateAttribution:'dated-entry-or-explicit-invalidation; undated-parent-assessment-on-first-saved-entry',currentRulesNotAppliedRetroactively:true};
}
