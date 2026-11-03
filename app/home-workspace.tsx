'use client';
import React from 'react';
import { Check, Plus, ArrowUpRight } from 'lucide-react';
import { periodKey, moneyFormat, todayCN } from '../lib/domain';
import type { DailyRecord, Settings } from '../lib/domain';
import { dailyExecutionSummary } from '../lib/calculations';
import { hasExecution, tradeCurrency } from '../lib/trading';
import type { TradeRecord } from '../lib/trading';
import { riskSnapshot } from '../lib/g1';
import { vnextRiskAssessment } from '../lib/vnext';
import { PositionSummary } from './trade-calculation-fields';
import { ReviewExport } from './review-export';

export function HomeWorkspace({records,trades,settings,openDay,newTrade,onAction,manage}:{records:DailyRecord[];trades:TradeRecord[];settings:Settings;openDay:(date:string)=>void;newTrade:()=>void;onAction:(t:TradeRecord,a:string)=>void;manage:()=>void}){
  const date=todayCN(),day=records.find(d=>d.date===date),a=dailyExecutionSummary(trades,date,settings),monday=periodKey(date,'week'),validTrades=trades.filter(t=>!t.archived&&hasExecution(t)),week=validTrades.filter(t=>tradeCurrency(t)===(settings.accountCurrency??'USD')).flatMap(t=>t.closes).filter(c=>c.date>=monday&&c.date<=date&&c.date>=settings.start&&c.date<=settings.end).reduce((n,c)=>n+c.netPnl,0),open=validTrades.filter(t=>t.status!=='closed'),alerts=open.filter(t=>{const r=t.riskRuleSnapshot?vnextRiskAssessment(t,settings):riskSnapshot(t,settings);return r.overHard||!r.ready;});
  const market=day?.quick?.market?({up:'上涨趋势',down:'下跌趋势',range:'震荡',transition:'趋势转换',uncertain:'不确定'} as Record<string,string>)[day.quick.market]:day?.environment??'尚未记录';
  return <><section className="card today-brief"><div><span className="eyebrow">{date} · 北京时间</span><h2>{day?'今天的观察已保存':'今天，从一次清晰判断开始'}</h2><div className="today-bits"><span>{market}</span><span>{day?<><Check size={13}/>已打卡</>:'待打卡'}</span><span>当前 {open.length} 笔持仓</span></div></div><div className="today-pnl"><div><span>今日已实现</span><strong className={a.net>=0?'positive':'negative'}>{moneyFormat(a.net,2)}</strong></div><div><span>本周已实现 · 验证期内</span><strong className={week>=0?'positive':'negative'}>{moneyFormat(week,2)}</strong></div></div><div className="today-actions"><button className="button primary" onClick={()=>openDay(date)}>{day?'补充今日观察':'今日快速打卡'}</button><button className="button secondary" onClick={newTrade}><Plus size={14}/>新建交易</button><ReviewExport/></div></section>{alerts.length>0&&<div className="warning-note">当前 {alerts.length} 笔持仓的核算风险超限或参数待补充。点开持仓核对费用、滑点和剩余风险；历史手工标记仍保留。</div>}<section className="card home-positions"><div className="card-title"><div><h2>当前持仓</h2><p>加仓和减仓直达；浮动行情只使用手动更新价格</p></div><button className="icon-text" onClick={manage}>全部持仓<ArrowUpRight size={14}/></button></div>{open.length?open.slice(0,3).map(t=><article key={t.id}><div className="section-title"><strong>{t.model} · {t.direction==='long'?'多':'空'} · {t.symbol}</strong><span>已实现 {moneyFormat(t.closes.reduce((n,c)=>n+c.netPnl,0),2)}</span></div><PositionSummary trade={t} settings={settings}/><div className="position-actions">{[['entry','加仓'],['close','减仓'],['closeAll','全部平仓'],['images','上传截图'],['edit','编辑交易']].map(([a,l])=><button key={a} className="button secondary" onClick={()=>onAction(t,a)}>{l}</button>)}</div></article>):<div className="compact-empty">暂无真实持仓。保留观察，等待计划中的机会。</div>}</section></>;
}
