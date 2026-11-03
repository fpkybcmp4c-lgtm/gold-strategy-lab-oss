'use client';
import React, { useEffect, useRef, useState } from 'react';
import { Activity, AlertTriangle, ChevronDown, Plus, Trash2 } from 'lucide-react';
import { readiness } from '../lib/wellbeing';
import type { DailyRecord } from '../lib/domain';
import type { Wellbeing } from '../lib/wellbeing-schema';

// Each text field owns its keystrokes. The parent receives a snapshot after a pause
// or blur; onDraft updates a ref and the debounced draft queue without rerendering it.
export function BufferedText({label,value,onDraft,onCommit,maxLength=5000,placeholder,rows}:{label:string;value:string;onDraft:(value:string)=>void;onCommit:()=>void;maxLength?:number;placeholder?:string;rows?:number}) {
  const [local,setLocal]=useState(value);
  const composing=useRef(false), timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const commitRef=useRef(onCommit);commitRef.current=onCommit;
  useEffect(()=>{setLocal(value);},[value]);
  useEffect(()=>()=>clearTimeout(timer.current),[]);
  const commit=()=>{clearTimeout(timer.current);if(!composing.current)commitRef.current();};
  const schedule=()=>{clearTimeout(timer.current);if(!composing.current)timer.current=setTimeout(commit,500);};
  const props={value:local,maxLength,placeholder,onChange:(e:React.ChangeEvent<HTMLInputElement|HTMLTextAreaElement>)=>{setLocal(e.target.value);onDraft(e.target.value);schedule();},
    onBlur:commit,onCompositionStart:()=>{composing.current=true;clearTimeout(timer.current);},onCompositionEnd:()=>{composing.current=false;schedule();}};
  return <label className="form-field"><span className="field-label">{label}</span>{rows?<textarea {...props} rows={rows}/>:<input {...props}/>}</label>;
}

export function OptionalRating({label,value,onChange,left,right}:{label:string;value?:number|null;onChange:(n:number|null)=>void;left:string;right:string}){
  return <div className={'form-field range-field optional-rating '+(value==null?'unanswered':'')}><div className="field-label"><label>{label}</label><strong>{value==null?'未填':`${value} / 10`}</strong><button className="icon-text" type="button" disabled={value==null} onClick={()=>onChange(null)}>清空</button></div><input type="range" min={0} max={10} step={1} value={value??5} aria-label={label} aria-valuetext={value==null?'未填写':`${value}分`} onChange={e=>onChange(Number(e.target.value))} onPointerUp={e=>onChange(Number(e.currentTarget.value))}/><div><span>{left}</span><span>{right}</span></div><div className="rating-shortcuts">{[0,3,5,7,10].map(n=><button key={n} className={value===n?'selected':''} type="button" aria-label={`${label} ${n}分`} aria-pressed={value===n} onClick={()=>onChange(n)}>{n}</button>)}</div></div>;
}
function OptionalChoice({label,value,onChange,yes='是',no='否'}:{label:string;value?:boolean|null;onChange:(v:boolean|null)=>void;yes?:string;no?:string}){
  return <div className="form-field"><span className="field-label">{label}</span><div className="choice optional-choice">{[[true,yes],[false,no],[null,'未填']].map(([v,text])=><button key={String(v)} type="button" className={(value??null)===v?'selected':''} aria-pressed={(value??null)===v} onClick={()=>onChange(v as boolean|null)}>{text}</button>)}</div></div>;
}

export function ReadinessCheck({day}:{day:DailyRecord}){
  const state=readiness(day);
  return <div className={'readiness-check '+state.status} role="status"><div className="readiness-heading"><Activity size={18}/><strong>交易状态检查 · {state.title}</strong></div><p>{state.body}</p>{state.partial&&state.status!=='unknown'&&<p>部分状态未填写，以上提示仅依据已有记录。</p>}{state.warnings.length>0&&<ul>{state.warnings.map(w=><li key={w}><AlertTriangle size={14}/><span>{w}</span></li>)}</ul>}<small>参考规则：压力或担忧 ≥8、精力 ≤3 或睡眠 &lt;5小时，建议暂停；压力或担忧 4–7、精力 4–6 或睡眠 5–不足6小时，谨慎筛选。未填值不补零。仅提供提示，不执行任何交易操作。</small></div>;
}

export function WellbeingFields({day,onChange,onTriggerDraft,onTextCommit}:{day:DailyRecord;onChange:(w:Wellbeing)=>void;onTriggerDraft:(v:string)=>void;onTextCommit:()=>void}){
  const w=day.wellbeing??{};
  const set=<K extends keyof Wellbeing>(key:K,value:Wellbeing[K])=>onChange({...w,[key]:value});
  const contexts=w.violationContexts??[];
  return <section className="form-section wellbeing-section"><details><summary><div><span className="section-number">04</span><Activity size={17}/><strong>精力与情绪</strong><span className="badge subtle">全部选填</span></div><ChevronDown size={16}/></summary><p className="muted-note">只记录自己的感受，约20秒。没填写的项目保持未知，仅你本人可查看。</p><div className="form-grid">
    <OptionalRating label="情绪压力" value={w.stress} onChange={v=>set('stress',v)} left="没有压力" right="压力很大"/>
    <OptionalRating label="反复担忧程度" value={w.worry} onChange={v=>set('worry',v)} left="能放下担忧" right="反复想，难放下"/>
    <OptionalRating label="整体精力" value={w.energy} onChange={v=>set('energy',v)} left="非常疲劳" right="精力充沛"/>
    <label className="form-field"><span className="field-label">睡眠时长（小时，选填）</span><input type="number" min={0} max={24} step="any" placeholder="未记录" value={w.sleepHours??''} onChange={e=>set('sleepHours',e.target.value===''?null:Number(e.target.value))}/><div className="sleep-shortcuts">{[5,6,7,8].map(n=><button key={n} type="button" className={w.sleepHours===n?'selected':''} onClick={()=>set('sleepHours',n)}>{n}小时</button>)}<button type="button" onClick={()=>set('sleepHours',null)}>清空</button></div></label>
    <OptionalChoice label="今日运动" value={w.exercised} onChange={v=>set('exercised',v)}/>
    <div className="form-field full"><BufferedText label="主要情绪触发事件（选填）" value={w.trigger??''} onDraft={onTriggerDraft} onCommit={onTextCommit} rows={3} placeholder="例如：工作压力、上一笔止损、反复查看行情……"/></div>
  </div><div className="risk-trigger-options"><span className="field-label">当下需要留意的念头（选填）</span><label className="checkbox-label"><input type="checkbox" checked={!!w.recoveryUrgency} onChange={e=>set('recoveryUrgency',e.target.checked)}/>急于回本</label><label className="checkbox-label"><input type="checkbox" checked={!!w.impulsiveReversal} onChange={e=>set('impulsiveReversal',e.target.checked)}/>想冲动反手</label><p className="muted-note">踏空焦虑直接使用上方已有的 FOMO 评分。</p></div>
  {day.violations>0&&<div className="violation-contexts"><div className="section-title"><span className="field-label">违规发生时间与当时状态（选填）</span><button type="button" className="icon-text" disabled={contexts.length>=Math.min(day.violations,100)} onClick={()=>set('violationContexts',[...contexts,{time:null,fatigued:null}])}><Plus size={14}/>补充一次</button></div><p className="muted-note">已有违规共 {day.violations} 次。这里补充背景，不增加次数；时间使用北京时间。</p>{contexts.map((c,i)=><div className="violation-context" key={i}><label className="form-field"><span className="field-label">第 {i+1} 次 · 时间</span><input type="time" value={c.time??''} onChange={e=>set('violationContexts',contexts.map((old,j)=>i===j?{...old,time:e.target.value||null}:old))}/></label><OptionalChoice label="当时明显疲劳？" value={c.fatigued} onChange={v=>set('violationContexts',contexts.map((old,j)=>i===j?{...old,fatigued:v}:old))}/><button className="icon-button" type="button" aria-label={`移除第${i+1}次违规背景`} onClick={()=>set('violationContexts',contexts.filter((_,j)=>j!==i))}><Trash2 size={15}/></button></div>)}</div>}
  </details><ReadinessCheck day={day}/></section>;
}
