import { assessedDiscipline, discipline, pnl, recordR, riskR } from './domain.ts';
import type { DailyRecord, Settings } from './domain.ts';

export function dailyCSV(records:DailyRecord[],settings:Settings,isDemo=false){
  const header=['数据类型','日期','行情','形态','A类机会','新开仓','未平仓','已平仓笔数','净损益'+(settings.accountCurrency??'USD'),'已知风险R合计','R覆盖笔数','纪律评分','遵守计划','违规次数','风险合规','FOMO','冲动次数','成功克制','盯盘分钟','填报日内回撤'+(settings.accountCurrency??'USD'),'计划内净损益','计划外净损益','复盘','情绪压力','反复担忧','整体精力','睡眠小时','今日运动','情绪触发事件','急于回本','冲动反手念头','违规时间与疲劳背景JSON'];
  const yesNo=(v?:boolean|null)=>v==null?'':v?'是':'否';
  const rows=records.map(d=>{const has=d.hasDailyState!==false,state=(v:unknown)=>has?v:'';return [isDemo?'示例':'正式',d.date,state(d.environment),state(d.pattern),state(yesNo(d.aOpportunity)),d.newTrades,d.openPositions,d.trades.filter(t=>!t.partial).length,pnl(d),recordR(d)??'',d.trades.filter(t=>riskR(t)!==null).length,state(assessedDiscipline(d,settings.riskLimit)??''),state(d.disciplineAssessed===false?'':yesNo(d.planCompliant)),state(d.violations),state(yesNo(d.riskCompliant)),state(d.fomoRecorded===false?'':d.fomo),state(d.impulses),state(d.resisted),state(d.screenMinutes),d.intradayDrawdown??'',d.trades.filter(t=>t.inPlan).reduce((s,t)=>s+t.netPnl,0),d.trades.filter(t=>!t.inPlan).reduce((s,t)=>s+t.netPnl,0),d.note,
    d.wellbeing?.stress??'',d.wellbeing?.worry??'',d.wellbeing?.energy??'',d.wellbeing?.sleepHours??'',yesNo(d.wellbeing?.exercised),d.wellbeing?.trigger??'',yesNo(d.wellbeing?.recoveryUrgency),yesNo(d.wellbeing?.impulsiveReversal),d.wellbeing?.violationContexts?.length?JSON.stringify(d.wellbeing.violationContexts):''];});
  const cell=(v:unknown)=>{let s=String(v);if(/^[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
  return '\uFEFF'+[header,...rows].map(row=>row.map(cell).join(',')).join('\r\n');
}
