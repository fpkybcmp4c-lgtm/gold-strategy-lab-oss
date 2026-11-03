'use client';
import React from 'react';
import type { Settings } from '../lib/domain';
import { currentEffectiveRules } from '../lib/vnext';
import { Num } from './form-fields';

export function RiskRuleSettings({settings,onChange}:{settings:Settings;onChange:(value:Settings)=>void}){
  const rules=currentEffectiveRules(settings);
  return <section className="form-section"><h3>新交易 · 双层风险预算</h3><p className="muted-note">每笔新交易保存规则快照。以后修改不会改变旧交易的初始风险、R或原始合规判断。</p>{(['G1','independent'] as const).map(framework=><div key={framework}><strong>{framework==='G1'?'G1顺势主系统':'非G1独立结构系统'}</strong><div className="form-grid">{(['normalMin','normalMax','hardLimit'] as const).map((key,i)=><Num key={key} label={['常规下限 USD','常规上限 USD','硬上限 USD'][i]} value={rules[framework][key]} onChange={value=>onChange({...settings,riskRules:{...rules,[framework]:{...rules[framework],[key]:value??0}}})}/>)}</div><p className="muted-note">生效：{rules[framework].effectiveAt?new Date(rules[framework].effectiveAt!).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'尚无历史生效时间'}{framework==='independent'?' · 初期14天禁止亏损加仓':''}</p></div>)}<p className="muted-note">超过常规上限需填写原因；实际超限成交仍可如实登记并标记违规。预算按USD记录，其他结算币种保持未知，不自动换算。</p></section>;
}
