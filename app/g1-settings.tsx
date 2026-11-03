'use client';
import React from 'react';
import { DEFAULT_G1 } from '../lib/g1-schema';
import type { G1Settings } from '../lib/g1-schema';
import { ContractFields } from './g1-fields';
import { Num } from './form-fields';
import { BufferedText } from './wellbeing-fields';
export function G1SettingsFields({value,onChange,onRuleDraft,onCommit}:{value?:G1Settings;onChange:(v:G1Settings)=>void;onRuleDraft:(v:string)=>void;onCommit:()=>void}){
  const c=value??DEFAULT_G1;
  return <details className="form-section"><summary>G1 · 候选策略参数</summary><p className="muted-note">常规风险160–240，硬上限沿用上方已保存的设置。候选参数可调整，没有已验证的最佳组合。合约配置保存后仅作为新增计划的默认快照。</p><div className="form-grid"><Num label="常规风险下限 USD" value={c.normalRiskMin} onChange={v=>onChange({...c,normalRiskMin:v as number})}/><Num label="常规风险上限 USD" value={c.normalRiskMax} onChange={v=>onChange({...c,normalRiskMax:v as number})}/>{c.allocation.map((n,i)=><Num key={i} label={`第${i+1}笔数量权重`} value={n} onChange={v=>onChange({...c,allocation:c.allocation.map((old,j)=>i===j?v:old) as G1Settings['allocation']})}/>)}<Num label="冷却：等待完整4小时K线数" value={c.coolingBars} onChange={v=>onChange({...c,coolingBars:v as number})}/><Num label="结构确认K线数" value={c.confirmationBars} onChange={v=>onChange({...c,confirmationBars:v as number})}/><Num label="ATR缓冲倍数" value={c.atrBuffer} onChange={v=>onChange({...c,atrBuffer:v as number})}/><div className="full"><BufferedText label="各级别结构确认规则" value={c.confirmationRule} rows={2} onDraft={onRuleDraft} onCommit={onCommit}/></div></div><h3>分批止盈候选规则</h3><div className="form-grid">{(['firstR','firstPercent','secondR','secondPercent'] as const).map((key,i)=><Num key={key} label={['第一目标R','第一止盈百分比','第二目标R','第二止盈百分比'][i]} value={c.takeProfit?.[key]??([1.5,50,2.5,25][i])} onChange={v=>onChange({...c,takeProfit:{...(c.takeProfit??{firstR:1.5,firstPercent:50,secondR:2.5,secondPercent:25}),[key]:v as number}})}/>)}</div><p className="muted-note">候选方案为1.5R减50%、2.5R减25%，余量按1小时结构管理。新计划保存参数快照，修改不会重解释旧交易。</p><h3>XAUUSDT.P · 请核对自己的平台规格</h3><ContractFields value={c.contract} onChange={contract=>onChange({...c,contract})}/></details>;
}
