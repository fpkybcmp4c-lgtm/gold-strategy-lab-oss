'use client';
import React from 'react';
import type { Settings } from '../lib/domain';
import { moneyFormat } from '../lib/domain';
import { calculateTradePnl, closeCalculation, estimatedExecutionFee, planCalculation, tradeContract } from '../lib/calculations';
import { vnextRiskAssessment } from '../lib/vnext';
import { inventory, riskSnapshot } from '../lib/g1';
import type { CloseEvent, TradeRecord } from '../lib/trading';
import { totalRealized } from '../lib/trading';
import { Num } from './form-fields';
import { instrumentOf } from '../lib/multi-asset';
const n=(v:number|null|undefined,d=2)=>v==null||!Number.isFinite(v)?'—':moneyFormat(v,d);
const feeNumber=(v:number|null|undefined)=>v==null||!Number.isFinite(v)?'未录':new Intl.NumberFormat('en-US',{maximumFractionDigits:8,minimumFractionDigits:2}).format(v);
type Change=(patch:Partial<TradeRecord>,render?:boolean)=>void;

export function TradeFeeFields({trade,settings,change,read}:{trade:TradeRecord;settings:Settings;change:Change;read:()=>TradeRecord}){
  const c=tradeContract(trade,settings),p=calculateTradePnl(trade,settings),entries=trade.entries??[],estimatedOpening=estimatedExecutionFee(c,trade.quantity,trade.entryPrice,'entry');
  const opening=entries.length?p.totalEntryFees:trade.aggregateEntryFee??estimatedOpening;
  const closing=p.totalExitFees,total=opening!==null&&closing!==null?opening+closing:null;
  const entryEstimate=entries.length?entries.some(e=>e.feeSource==='estimated'):trade.aggregateEntryFee==null&&estimatedOpening!==null;
  const exitEstimate=trade.closes.some(e=>e.feeSource==='estimated');
  const updateEntry=(id:string,fees:number|null,feeSource:'actual'|'estimated')=>change({entries:(read().entries??[]).map(e=>e.id===id?{...e,fees,feeSource}:e)});
  const updateClose=(id:string,fees:number|null,feeSource:'actual'|'estimated')=>change({closes:read().closes.map(e=>e.id===id?{...e,fees,feeSource}:e)});
  return <section className="form-section trade-fees" aria-label="交易费用"><div className="section-title"><h3>开仓费用、平仓费用与总费用</h3><span className="badge subtle">{c.currency??'USD'}</span></div>
    <div className="calculation-grid"><div><span>开仓手续费{entryEstimate?' · 含估算':''}</span><strong>{feeNumber(opening)} {p.currency}</strong></div><div><span>平仓手续费{exitEstimate?' · 含估算':''}</span><strong>{trade.closes.length?`${feeNumber(closing)} ${p.currency}`:'尚无平仓事件'}</strong></div><div><span>当前手续费合计{entryEstimate||exitEstimate?' · 含估算':''}</span><strong>{feeNumber(total)} {p.currency}</strong></div></div>
    <div className="form-grid" style={{marginTop:12}}>{entries.length?entries.map((entry,index)=><div className="form-field" key={entry.id}><Num label={`第${index+1}次开仓手续费 · 手动覆盖`} value={entry.fees} onChange={fees=>updateEntry(entry.id,fees,'actual')}/><button type="button" className="icon-text" onClick={()=>updateEntry(entry.id,estimatedExecutionFee(c,entry.quantity,entry.price,'entry'),'estimated')}>按合约规则估算本次开仓费</button><small>{entry.feeSource==='estimated'?'估算 · 待核对':'手动录入 / 历史费用'} · {entry.date}</small></div>):<div className="form-field"><Num label="开仓手续费 · 手动覆盖（留空使用估算）" value={trade.aggregateEntryFee??null} onChange={aggregateEntryFee=>change({aggregateEntryFee})}/><button type="button" className="icon-text" onClick={()=>change({aggregateEntryFee:null})}>使用合约规则估算开仓费</button><small>合约估算：{feeNumber(estimatedOpening)} {p.currency}。实际费用填写后优先使用。</small></div>}
      {trade.closes.map((close,index)=><div className="form-field" key={close.id}><Num label={`第${index+1}次平仓手续费 · 手动覆盖`} value={close.fees} onChange={fees=>updateClose(close.id,fees,'actual')}/><button type="button" className="icon-text" onClick={()=>updateClose(close.id,estimatedExecutionFee(c,close.quantity,close.price,'exit'),'estimated')}>按合约规则估算本次平仓费</button><small>{close.feeSource==='estimated'?'估算 · 待核对':'手动录入 / 历史费用'} · {close.date}</small></div>)}
    </div><p className="muted-note">每次分批开仓和平仓的费用分别保存。部分平仓仅分摊对应开仓费；当前费用合计包含尚未平仓部分的开仓费。留空且无法估算时保持未知，不填0。券商净额已扣费，不再次扣减。</p>
  </section>;
}

export function PlanPreview({trade,settings}:{trade:TradeRecord;settings:Settings}){
  const base=planCalculation(trade,settings),p=vnextRiskAssessment(trade,settings),recorded=calculateTradePnl(trade,settings),contract=tradeContract(trade,settings);
  const partial=base;
  const currency=p.currency==='UNKNOWN'?'USD':p.currency;
  const recordedEntryFees=trade.entries?.length?recorded.totalEntryFees:trade.aggregateEntryFee??null;
  const entryFeeLabel=trade.entries?.some(entry=>entry.feeSource==='estimated')?'开仓手续费 · 含估算':'已录开仓手续费';
  const cells=[['止损毛风险',`${n(base.priceRisk)} ${currency}`],['目标毛收益',`${n(partial.targetGross)} ${currency}`],['计划毛盈亏比',partial.grossRR!=null?`1 : ${n(partial.grossRR)}`:p.grossRR!=null?`1 : ${n(p.grossRR)}`:'—'],[entryFeeLabel,`${feeNumber(recordedEntryFees)} ${currency}`],[p.totalRisk!==null?'完整交易净风险':'已知风险下界',p.totalRisk!==null?`${n(p.totalRisk)} ${currency}`:base.knownRiskFloor!==null?`${n(base.knownRiskFloor)} ${currency} + 费用/滑点`:'—'],['账户风险',p.riskPct!==null?`${n(p.riskPct)}%`:base.knownRiskPct!==null?`至少 ${n(base.knownRiskPct)}%`:'—']];
  const state=p.overHard?'超过硬上限':p.overNormal?'超过常规预算':p.framework==='pending'?'策略待确认':p.ready?'已核算':base.priceRisk!==null?'价格风险已核算':'填写成交与止损';
  return <section className="plan-preview" aria-label="自动交易计划预览"><div className="section-title"><strong>计划与风险</strong><span className={'badge '+(p.overHard?'risk-high':p.overNormal?'warning':'subtle')}>{state}</span></div><div className="calculation-grid">{cells.map(([label,value])=><div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
    {!p.ready&&base.priceRisk!==null&&<p className="muted-note">已知风险包含已录成本；补齐剩余费用及滑点后显示完整净风险，未知成本不会填0。<a className="icon-text" href={'#contract-settings-'+instrumentOf(trade)} target="_blank" rel="noopener">设置预计费用</a></p>}
    <details className="form-section"><summary>费用预算与风险明细</summary><div className="calculation-grid">
      {[['完整交易净风险',`${n(p.totalRisk)} ${currency}`],['初始R基准',trade.initialRisk===null?'尚未记录':`${n(trade.initialRisk)} ${currency}`],['止损 / 止盈距离',`${n(base.stopDistance)} / ${n(base.targetDistance)}`],['预计费用 / 滑点',`${n(p.fees)} / ${n(p.slippage)} ${currency}`],['计划净盈亏比',p.netRR===null?'—':`1 : ${n(p.netRR)}`],['常规预算 / 硬上限',`${n(p.normalMin)}—${n(p.normalMax)} / ${n(p.hardLimit)} ${currency}`],['常规预算最大数量',n(p.maximum,4)],['整笔假设当前风险',`${n(p.remainingRisk)} ${currency}`],['剩余持仓风险',`${n(p.openPositionRisk)} ${currency}`]].map(([label,value])=><div key={label}><span>{label}</span><strong>{value}</strong></div>)}
    </div><p className="muted-note">同一交易假设的分仓合并核算，包含已知及预计费用和滑点。初始风险保留为整笔R分母，不随最新预算或后续盈亏重置。</p></details>
    {!p.ready&&base.priceRisk===null&&<p className="muted-note">填写方向、数量、开仓与止损价格。合约配置可在设置中一次维护。</p>}
    {contract.settlement==='inverse'&&<p className="warning-note">反向合约使用券商扣费后净额，不套用线性公式。</p>}
  </section>;
}
export function PositionSummary({trade,settings}:{trade:TradeRecord;settings:Settings}){
  const p=inventory(trade),r=riskSnapshot(trade,settings),c=tradeContract(trade,settings);
  const fees=calculateTradePnl(trade,settings);
  const opening=trade.entries?.length?fees.totalEntryFees:trade.aggregateEntryFee??null,total=opening!==null&&fees.totalExitFees!==null?opening+fees.totalExitFees:null;
  return <div className="position-summary"><div><span>剩余数量</span><strong>{n(p.quantity,4)}</strong></div><div><span>持仓成本均价</span><strong>{n(p.price,4)}</strong></div><div><span>硬止损 / 目标</span><strong>{n(trade.currentStop??trade.originalStop)} / {n(trade.targetPrice)}</strong></div><div><span>开仓费用</span><strong>{feeNumber(opening)} {fees.currency}</strong></div><div><span>平仓费用</span><strong>{trade.closes.length?feeNumber(fees.totalExitFees):'尚未平仓'} {fees.currency}</strong></div><div><span>总手续费</span><strong>{feeNumber(total)} {fees.currency}</strong></div><div><span>剩余止损风险</span><strong>{n(r.openRisk)} {c.currency??'USD'}</strong></div></div>;
}

export function ClosePreview({trade,close,settings,change}:{trade:TradeRecord;close:CloseEvent;settings:Settings;change:(p:Partial<CloseEvent>)=>void}){
  const p=closeCalculation(trade,close,settings),contract=tradeContract(trade,settings),instrument=instrumentOf(trade),risk=trade.initialRisk!==null&&trade.initialRisk>0?trade.initialRisk:null,known=trade.closes.every(event=>Number.isFinite(event.netPnl)),cumulative=known?totalRealized(trade):null,remaining=close.quantity===null?null:Math.max(0,p.quantityBefore-close.quantity);
  const net=close.calculationMode==='automatic'?p.net:Number.isFinite(close.netPnl)?close.netPnl:null;
  const closeFees=p.allocatedEntryFee!==null&&p.exitFee!==null?p.allocatedEntryFee+p.exitFee:null;
  const cells=[['本次毛盈亏',`${feeNumber(p.gross)} ${p.currency}`],['开仓费分摊 / 平仓费',`${feeNumber(p.allocatedEntryFee)} / ${feeNumber(p.exitFee)}`],['本次手续费合计',`${feeNumber(closeFees)} ${p.currency}`],['其他已记录成本',`${feeNumber(p.otherCosts)} ${p.currency}`],['本次净盈亏',`${feeNumber(net)} ${p.currency}`],['本次净R',n(net!==null&&risk!==null?net/risk:null)],['累计已实现净额',`${n(cumulative)} ${p.currency}`],['父交易累计净R',n(cumulative!==null&&risk!==null?cumulative/risk:null)],['本次后剩余数量',`${n(remaining,4)} ${instrument}合约单位`],['记录剩余风险',`${n(vnextRiskAssessment(trade,settings).openPositionRisk)} ${p.currency}`]];
  return <div className="close-preview"><div className="calculation-grid">{cells.map(([label,value])=><div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>{close.calculationMode==='automatic'?<p className="muted-note fee-equation" aria-label="本次净盈亏计算">毛盈亏 {feeNumber(p.gross)} − 开仓费分摊 {feeNumber(p.allocatedEntryFee)} − 平仓费 {feeNumber(p.exitFee)} − 其他已记录成本 {feeNumber(p.otherCosts)} = 净盈亏 {feeNumber(net)} {p.currency}。成交价已包含的滑点不重复扣减。</p>:<p className="muted-note">当前采用券商扣费后净额 {feeNumber(net)} {p.currency}；费用仅补充明细，不再次从该净额扣除。</p>}{close.calculationMode==='automatic'&&!p.ready&&<p className="warning-note">自动结算需实际数量、价格、合约乘数及开平仓费用。缺少实际开仓费时可补全，或在高级结算中切换为券商净额。</p>}{(close.feeSource==='estimated'||p.entryFeeEstimated)&&<p className="muted-note">净额中含估算费用，实际费用统计不会将估算项当作真实费用。</p>}{contract.settlement==='inverse'&&<p className="warning-note">反向合约请使用券商扣费后净额；核对结算币种后登记，不自动计算盈亏。</p>}<details className="form-section"><summary>费用来源、其他成本与历史结算方式</summary><div className="form-grid" style={{paddingTop:12}}><label className="form-field"><span className="field-label">结算方式</span><select value={close.calculationMode??'reported'} onChange={event=>change({calculationMode:event.target.value as CloseEvent['calculationMode']})}><option value="automatic" disabled={contract.settlement==='inverse'}>自动按成交成本核算</option><option value="reported">券商扣费后净額 / 历史原值</option></select></label><label className="form-field"><span className="field-label">费用来源</span><select value={close.feeSource??'actual'} onChange={event=>change({feeSource:event.target.value as CloseEvent['feeSource'],...(event.target.value==='estimated'?{fees:estimatedExecutionFee(contract,close.quantity,close.price,'exit')}:{})})}><option value="actual">实际费用</option><option value="estimated">估算费用 · 后续核对</option></select></label><Num label="其他已记录成本 · 成交价已含滑点勿重复扣" value={close.otherCosts??null} onChange={otherCosts=>change({otherCosts})}/></div></details><p className="muted-note">部分平仓保留在同一父交易下，不作为完整独立样本。移动加权成本分摊费用，已保存1R不随加仓或减仓重置。</p></div>;
}
