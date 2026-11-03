import { blankDay } from './domain.ts';
import type { DailyRecord, Trade } from './domain.ts';
import { tradeCurrency, compatibleTrades, hasExecution, finalDate, isLegacySummary, orderedCloses, totalRealized } from './trading.ts';
import type { TradeRecord } from './trading.ts';
import { dailyDisciplineEvidence } from './discipline-evidence.ts';

// A derived view only. Never save this projection back into daily_records.
export function ledgerDays(rawDays:DailyRecord[],stored:TradeRecord[],currency?:string):DailyRecord[]{
  const trades=compatibleTrades(rawDays,stored).filter(t=>!t.archived&&hasExecution(t)&&(!currency||tradeCurrency(t)===currency));
  const days=new Map<string,DailyRecord>(rawDays.map(d=>[d.date,{...d,hasDailyState:true,reportedNewTrades:d.newTrades,reportedOpenPositions:d.openPositions,newTrades:0,openPositions:0,trades:[],tradeRisks:[]}]));
  const at=(date:string)=>{let d=days.get(date);if(!d){d={...blankDay(date),hasDailyState:false,tradeRisks:[]};days.set(date,d);}return d;};
  for(const t of trades){
    if(t.openedDate&&hasExecution(t)){const d=at(t.openedDate);d.newTrades++;d.tradeRisks!.push(t.initialRisk);}
    for(const e of t.entries??[])at(e.date);
    if(isLegacySummary(t)){
      const d=at(t.legacy!.dailyDate);d.tradeRisks!.push(t.initialRisk);
      d.trades.push({id:t.id,model:t.model,netPnl:totalRealized(t),initialRisk:t.initialRisk,inPlan:t.inPlan,lifecycleId:t.id,closeEvent:false});
      continue;
    }
    const closes=orderedCloses(t),last=closes.at(-1);
    for(const c of closes){
      const complete=t.status==='closed'&&last?.id===c.id;
      const event:Trade={id:t.id+':'+c.id,model:t.model,netPnl:c.netPnl,initialRisk:t.initialRisk,inPlan:t.inPlan,lifecycleId:t.id,closeEvent:true,partial:!complete,...(complete?{tradeNetPnl:totalRealized(t),rPnl:totalRealized(t)}:{})};
      at(c.date).trades.push(event);
    }
  }
  for(const d of days.values())d.openPositions=trades.filter(t=>{if(!hasExecution(t)||!t.openedDate||t.openedDate>d.date)return false;if(t.entries?.length)return t.entries.filter(e=>e.date<=d.date).reduce((s,e)=>s+e.quantity,0)-t.closes.filter(c=>c.date<=d.date).reduce((s,c)=>s+(c.quantity??0),0)>1e-8;return !finalDate(t)||finalDate(t)!>d.date;}).length;
  return [...days.values()].map(day=>({...day,executionDiscipline:dailyDisciplineEvidence(trades,day.date)})).sort((a,b)=>a.date.localeCompare(b.date));
}
