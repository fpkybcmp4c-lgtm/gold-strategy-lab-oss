'use client';
import React, { useEffect, useRef, useState } from 'react';
import { QuickCheckin, DailyAutoSummary } from './quick-checkin';
import { Check, ChevronRight, FlaskConical, Plus, Trash2, X } from 'lucide-react';
import { blankDay, dailyDraftSchema, dailySchema, assessedDiscipline, discipline, ENVIRONMENTS, MODELS, moneyFormat, pnl, recordR, riskR } from '../lib/domain';
import type { DailyRecord, Settings, Trade } from '../lib/domain';
import type { DailyDraft } from '../lib/repository';
import type { HistoryEntry, TradeImage, TradeRecord } from '../lib/trading';
import { HistoryPanel, ScreenshotGallery, tradeAPI } from './trade-workspace';
import { createDraftWriter } from '../lib/draft-writer';
import type { DraftStatus } from '../lib/draft-writer';
import { useDialogFocus } from './use-dialog-focus';
import { BufferedText, ReadinessCheck, WellbeingFields } from './wellbeing-fields';

const number=(n:number|null)=>n===null?'—':moneyFormat(n,2);
const dollars=(n:number)=>(n>0?'+':n<0?'−':'')+'$'+moneyFormat(Math.abs(n),2);
const tone=(n:number)=>n>0?'positive':n<0?'negative':'';
const unassessedDay=(date:string):DailyRecord=>({...blankDay(date),disciplineAssessed:false,fomoRecorded:false});
async function draftAPI<T={ok:boolean}>(date:string,method='GET',record?:DailyRecord):Promise<T>{
  const body=record?JSON.stringify(record):undefined;
  const response=await fetch('/api/drafts?date='+date,{method,credentials:'same-origin',cache:'no-store',headers:body?{'Content-Type':'application/json'}:undefined,body,keepalive:!!body&&new TextEncoder().encode(body).length<60000});
  const value=await response.json() as T&{error?:string};if(!response.ok)throw new Error(value.error??'草稿保存失败');return value;
}
function Choice({label,value,onChange,labels=['是','否']}:{label:string;value:boolean;onChange:(v:boolean)=>void;labels?:[string,string]}){return <div className="form-field"><span className="field-label">{label}</span><div className="choice">{[true,false].map((v,i)=><button type="button" key={String(v)} className={value===v?'selected':''} aria-pressed={value===v} onClick={()=>onChange(v)}>{labels[i]}</button>)}</div></div>;}
function NumberField({label,value,onChange,min=0,max=10000,optional=false,step=1}:{label:string;value:number|null;onChange:(v:number|null)=>void;min?:number;max?:number;optional?:boolean;step?:number}){return <label className="form-field"><span className="field-label">{label}</span><input type="number" value={value??''} min={min} max={max} step={step} required={!optional} placeholder={optional?'可留空':''} onChange={e=>onChange(e.target.value===''?(optional?null:0):Number(e.target.value))}/></label>;}

export default function DayEditor({initial,records,settings,demo,saving,onClose,save,trades=[],onNewTrade,onOpenTrade}:{initial:DailyRecord;records:DailyRecord[];settings:Settings;demo:boolean;saving:boolean;onClose:()=>void;save:(d:DailyRecord)=>Promise<void>;trades?:TradeRecord[];onNewTrade?:(date:string)=>void;onOpenTrade?:(trade:TradeRecord)=>void}){
  const [day,setDay]=useState<DailyRecord>(()=>dailyDraftSchema.parse({...initial,...(!records.some(record=>record.date===initial.date)&&!initial.quick&&!initial.wellbeing?{disciplineAssessed:false,fomoRecorded:false}:{})}));
  const [dailyImages,setDailyImages]=useState<TradeImage[]>([]);
  const [history,setHistory]=useState<HistoryEntry[]>([]);
  const dayRef=useRef(day),baseline=useRef(records.find(d=>d.date===initial.date)??unassessedDay(initial.date));
  const [mode,setMode]=useState<'quick'|'full'>('quick');
  const [review,setReview]=useState(false),[error,setError]=useState(''),[ready,setReady]=useState(demo),[busy,setBusy]=useState(false);
  const [draftStatus,setDraftStatus]=useState<DraftStatus>('idle'),[draftError,setDraftError]=useState(''),[restored,setRestored]=useState(false);
  const mounted=useRef(false),requestId=useRef(0),writer=useRef<ReturnType<typeof createDraftWriter<DailyRecord>>|null>(null);
  const existing=records.some(d=>d.date===day.date),outside=day.date<settings.start||day.date>settings.end;

  async function restore(date:string){
    const id=++requestId.current;
    setReady(false);setDraftError('');setError('');setHistory([]);
    const confirmed=structuredClone(records.find(d=>d.date===date)??unassessedDay(date));
    try{
      const [{draft},imageResult]=await Promise.all([draftAPI<{draft:DailyDraft|null}>(date),tradeAPI<{images:TradeImage[]}>('/api/images?tradeId='+encodeURIComponent('daily:'+date))]);
      if(!mounted.current||id!==requestId.current)return;
      setDailyImages(imageResult.images??[]);baseline.current=confirmed;
      const restoredDay=draft?dailyDraftSchema.parse(draft.record):confirmed;
      dayRef.current=restoredDay;setDay(restoredDay);setRestored(!!draft);setDraftStatus(draft?'saved':'idle');setReady(true);
    }catch(e){if(mounted.current&&id===requestId.current)setDraftError((e as Error).message);}
  }
  useEffect(()=>{
    mounted.current=true;
    writer.current=createDraftWriter<DailyRecord>(d=>draftAPI(d.date,'PUT',d),(status,message)=>{
      if(!mounted.current)return;setDraftStatus(status);if(status==='error')setDraftError(message??'草稿未能保存');else setDraftError('');
    });
    if(!demo)void restore(initial.date);
    const flush=()=>{if(!demo)void writer.current?.flush().catch(()=>{});};
    const unload=(event:BeforeUnloadEvent)=>{if(!demo&&writer.current?.hasPending()){flush();event.preventDefault();event.returnValue='';}};
    const visibility=()=>{if(document.visibilityState==='hidden')flush();};
    window.addEventListener('beforeunload',unload);document.addEventListener('visibilitychange',visibility);
    return ()=>{mounted.current=false;requestId.current++;writer.current?.close();window.removeEventListener('beforeunload',unload);document.removeEventListener('visibilitychange',visibility);};
    // This editor instance owns the initial record; date switches explicitly restore below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  function mutate(change:(old:DailyRecord)=>DailyRecord,render=true){
    const next=change(dayRef.current);dayRef.current=next;if(render)setDay(next);if(!demo)writer.current?.enqueue(next);
  }
  const update=<K extends keyof DailyRecord>(key:K,value:DailyRecord[K])=>mutate(d=>({...d,[key]:value}));
  const text=(key:'pattern'|'note'|'dailyTrend'|'fourHourTrend'|'marketPlan'|'oneHourTrend'|'zones'|'marketHypothesis'|'macroInfo',value:string)=>mutate(d=>({...d,[key]:value}),false);
  const commitText=()=>setDay({...dayRef.current});
  const dirty=()=>JSON.stringify(dayRef.current)!==JSON.stringify(baseline.current);
  async function close(){
    if(saving||busy)return;
    if(demo&&dirty()&&!window.confirm('示例填写尚未提交，确定关闭吗？'))return;
    setBusy(true);setError('');
    try{if(!demo)await writer.current?.flush();onClose();}catch(e){setError((e as Error).message);}finally{if(mounted.current)setBusy(false);}
  }
  const dialogRef=useDialogFocus(()=>void close());
  async function changeDate(value:string){
    if(!value||value===dayRef.current.date)return;
    if(demo){if(dirty()&&!window.confirm('切换日期会替换示例填写，确定切换吗？'))return;const next=structuredClone(records.find(d=>d.date===value)??unassessedDay(value));baseline.current=next;dayRef.current=next;setDay(next);setError('');return;}
    setBusy(true);try{await writer.current?.flush();await restore(value);}catch(e){setError((e as Error).message);}finally{if(mounted.current)setBusy(false);}
  }
  async function discardDraft(){
    if(!window.confirm('放弃这一天的未提交草稿，恢复已确认的记录？'))return;
    setBusy(true);try{await writer.current?.flush();await draftAPI(dayRef.current.date,'DELETE');const next=structuredClone(baseline.current);dayRef.current=next;setDay(next);setRestored(false);setDraftStatus('idle');setError('');}catch(e){setError((e as Error).message);}finally{if(mounted.current)setBusy(false);}
  }
  function setCounts(key:'violations'|'impulses',v:number){mutate(d=>({...d,[key]:v,disciplineAssessed:true,planCompliant:v>0?false:d.planCompliant,...(key==='violations'&&d.wellbeing?.violationContexts?{wellbeing:{...d.wellbeing,violationContexts:d.wellbeing.violationContexts.slice(0,v)}}:{})}));}
  function validate(e:React.FormEvent){
    e.preventDefault();setError('');commitText();const result=dailySchema.safeParse(dayRef.current);
    if(!result.success){setError(result.error.issues[0].message);return;}
    if(result.data.riskCompliant&&result.data.trades.some(t=>t.initialRisk!==null&&t.initialRisk>settings.riskLimit)){setError('有交易超出风险上限，请选择风险不合规。');return;}
    dayRef.current=result.data;setDay(result.data);if(mode==='quick')void submit();else setReview(true);
  }
  async function submit(){
    setError('');setBusy(true);
    try{if(!demo)await writer.current?.flush();await save(dayRef.current);}catch(e){if(mounted.current)setError((e as Error).message);}finally{if(mounted.current)setBusy(false);}
  }
  const statusText=demo?'示例填写，仅本次会话':!ready?'恢复草稿中':draftStatus==='editing'?'正在编辑，停顿后保存草稿':draftStatus==='saving'?'正在保存草稿…':draftStatus==='saved'?'草稿已自动保存 · 尚未计入统计':draftStatus==='error'?'草稿未保存，请重试':'确认提交后计入正式统计';
  return <div className="modal-overlay"><div className={'modal wide day-dialog '+(mode==='quick'?'quick-dialog':'full-day-dialog')} ref={dialogRef} role="dialog" aria-modal="true" aria-label={review?'确认每日记录':existing?'编辑每日记录':'新增每日记录'} tabIndex={-1}>
    <div className="modal-header"><h2>{review?'确认这一天的记录':existing?'编辑每日观察':'快速记录今天'}</h2><button className="icon-button" disabled={saving||busy} aria-label="关闭并保留草稿" onClick={()=>void close()}><X size={20}/></button></div>
    <div className={'draft-status '+(draftError?'draft-failed':'')} role="status"><span>{statusText}</span>{restored&&!review&&<button type="button" disabled={busy||saving} onClick={()=>void discardDraft()}>放弃草稿</button>}</div>
    {draftError&&<div className="draft-error" role="alert"><span>{draftError}</span><button type="button" disabled={busy} onClick={()=>{if(!ready)void restore(dayRef.current.date);else void writer.current?.flush().catch(()=>{});}}>重试</button></div>}
    {review?<div className="review-submit"><div className={'submit-label '+(demo?'demo':'live')}>{demo?'示例记录 · 不计入正式验证':'正式记录 · 随账号保存'}</div><h3>{day.date}</h3><p>{day.environment} · 每日市场与个人状态</p>
      <div className="submit-stats"><div><span>交易记录</span><strong>独立保存</strong></div><div><span>已有交易数组</span><strong>原样保留</strong></div><div><span>纪律评分</span><strong>{assessedDiscipline(day,settings.riskLimit)??'尚未评价'} /100</strong></div><div><span>违规 / 冲动</span><strong>{day.violations} / {day.impulses}</strong></div></div>
      {day.wellbeing&&<div className="confirmed-wellbeing">压力 {day.wellbeing.stress??'未填'} · 担忧 {day.wellbeing.worry??'未填'} · 精力 {day.wellbeing.energy??'未填'} · 睡眠 {day.wellbeing.sleepHours??'未填'} 小时 · 运动 {day.wellbeing.exercised==null?'未填':day.wellbeing.exercised?'是':'否'}</div>}
      <ReadinessCheck day={day}/>{outside&&<p className="warning-note">此日期在验证期外，会保留作参考，不计入本期统计。</p>}{existing&&<p className="muted-note">保存会更新 {day.date} 的已有记录，不会重复增加一天。</p>}<p className="muted-note">保存每日状态不会清空或覆盖已有交易、平仓事件及截图。</p>{error&&<div role="alert" className="error-banner">{error}</div>}
      <div className="modal-actions"><button className="button secondary" disabled={saving||busy} onClick={()=>setReview(false)}>返回修改</button><button className="button primary" disabled={saving||busy} onClick={()=>void submit()}><Check size={16}/>{saving||busy?'保存中…':'确认并保存'}</button></div></div>:
    <form onSubmit={validate}><fieldset disabled={!ready||busy||saving} className="editor-fieldset"><div className="form-scroll">
      <div className="checkin-mode segmented"><button type="button" className={mode==='quick'?'selected':''} onClick={()=>setMode('quick')}>快速打卡</button><button type="button" className={mode==='full'?'selected':''} onClick={()=>setMode('full')}>完整复盘</button></div><label className="form-field checkin-date"><span className="field-label">观察日期 · 可补录历史</span><input type="date" value={day.date} onChange={e=>void changeDate(e.target.value)}/></label><DailyAutoSummary trades={trades} date={day.date} settings={settings}/>{mode==='quick'&&<QuickCheckin day={day} change={p=>mutate(d=>({...d,...p}))} text={v=>text('note',v)} commit={commitText} read={()=>dayRef.current} trades={trades} settings={settings}/>}<div hidden={mode!=='full'}><div className="form-intro"><FlaskConical size={16}/>{demo?'当前填写示例数据，放心试用。':'正式记录 · 北京时间 · 草稿停顿后自动保存，核对后确认提交。'}</div>
      <div className="form-section"><h3><span>01</span>市场与计划</h3><div className="form-grid">
        <label className="form-field"><span className="field-label">交易日</span><input type="date" required value={day.date} onChange={e=>void changeDate(e.target.value)}/></label>
        <label className="form-field"><span className="field-label">市场环境</span><select value={day.environment} onChange={e=>update('environment',e.target.value as DailyRecord['environment'])}>{ENVIRONMENTS.map(v=><option key={v}>{v}</option>)}</select></label>
        <label className="form-field"><span className="field-label">黄金市场状态</span><select value={day.marketState??''} onChange={e=>update('marketState',e.target.value as DailyRecord['marketState']||null)}><option value="">未记录</option><option value="trend">趋势</option><option value="range">震荡</option><option value="transition">转换</option></select></label><div className="full"><BufferedText key={'pattern'+day.date} label="结构 / 形态观察" value={day.pattern} maxLength={5000} rows={3} placeholder="例如：4小时下降趋势，供应区二次冲高失败" onDraft={v=>text('pattern',v)} onCommit={commitText}/></div>
        <Choice label="有 A 类机会吗？" value={day.aOpportunity} onChange={v=>update('aOpportunity',v)}/><label className="form-field"><span className="field-label">当日整体交易方向</span><select value={day.plannedDirection??''} onChange={e=>update('plannedDirection',e.target.value as DailyRecord['plannedDirection']||null)}><option value="">未记录</option><option value="long">偏多</option><option value="short">偏空</option><option value="observe">观察 / 不主动交易</option></select></label>{(['dailyTrend','fourHourTrend','oneHourTrend','zones','marketHypothesis','macroInfo','marketPlan'] as const).map((key,i)=><div className={key==='marketPlan'?'full':''} key={key}><BufferedText key={key+day.date} label={['日线趋势判断','4小时趋势判断','1小时结构','重要支撑与阻力','当日市场假设','宏观信息','当日交易计划'][i]} value={day[key]??''} rows={3} onDraft={v=>text(key,v)} onCommit={commitText}/></div>)}<NumberField label="当日最大回撤（USD，可空）" optional value={day.intradayDrawdown} step={0.01} max={1e9} onChange={v=>update('intradayDrawdown',v)}/>
      </div></div>
      {!demo&&<details className="form-section"><summary>市场K线截图 · {dailyImages.length} 张</summary><ScreenshotGallery key={day.date} tradeId={'daily:'+day.date} dailyDate={day.date} exists={ready} images={dailyImages} onChange={setDailyImages} beforeUpload={async()=>{writer.current?.enqueue(dayRef.current);await writer.current?.flush();}}/></details>}
      <div className="form-section"><div className="section-title"><h3><span>02</span>当日交易入口</h3>{!demo&&onNewTrade&&<button type="button" className="icon-text" onClick={()=>void (async()=>{await writer.current?.flush();onClose();onNewTrade(dayRef.current.date);})().catch(e=>setError(e.message))}><Plus size={15}/>新增独立交易</button>}</div><p className="muted-note">每笔交易、平仓及截图分别保存；这里仅编辑每日市场和个人状态。</p>
        <div className="day-trade-links">{trades.filter(t=>!t.archived&&(t.openedDate===day.date||t.legacy?.dailyDate===day.date||t.closes.some(c=>c.date===day.date)||t.entries?.some(e=>e.date===day.date))).map(t=><button type="button" key={t.id} onClick={()=>void (async()=>{await writer.current?.flush();onClose();onOpenTrade?.(t);})().catch(e=>setError(e.message))}><span>{t.model} · {t.symbol??'旧交易'} · {t.direction==='long'?'做多':t.direction==='short'?'做空':'方向未记录'}</span><span>查看交易<ChevronRight size={14}/></span></button>)}</div>
        {(day.newTrades>0||day.openPositions>0)&&<p className="legacy-notice">旧日报自报：新开仓 {day.newTrades} 笔，未平仓 {day.openPositions} 笔。保留原值，补录后以独立交易为准，不重复相加。</p>}
        {day.trades.length>0&&<p className="muted-note">保留旧交易数组 {day.trades.length} 笔；历史损益更正、截图与明细补充请在交易详情操作。</p>}
      </div>
      <div className="form-section"><h3><span>03</span>纪律与 FOMO</h3><div className="form-grid"><Choice label="是否遵守交易计划？" labels={['遵守计划','未遵守']} value={day.planCompliant} onChange={v=>mutate(d=>({...d,planCompliant:v,disciplineAssessed:true}))}/><label className="checkbox-label"><input type="checkbox" checked={day.disciplineAssessed!==false} onChange={e=>update('disciplineAssessed',e.target.checked)}/>已完成纪律评价</label><Choice label="单笔风险是否合规？" labels={['风险合规','不合规']} value={day.riskCompliant} onChange={v=>update('riskCompliant',v)}/><NumberField label="违规次数" value={day.violations} onChange={v=>setCounts('violations',v??0)}/><NumberField label="非计划冲动交易次数" value={day.impulses} onChange={v=>setCounts('impulses',v??0)}/><NumberField label="成功克制次数" value={day.resisted} onChange={v=>update('resisted',v??0)}/><NumberField label="主动盯盘时长（分钟）" value={day.screenMinutes} max={1440} onChange={v=>update('screenMinutes',v??0)}/><label className="form-field full range-field"><span className="field-label">FOMO / 踏空焦虑 <strong>{day.fomoRecorded===false?'未填写':day.fomo+' / 10'}</strong></span><input type="range" min={0} max={10} value={day.fomo} onChange={e=>mutate(d=>({...d,fomo:Number(e.target.value),fomoRecorded:true}))}/><div><span>平静，能等待</span><span>很急，想立刻进场</span></div></label></div><div className="form-summary"><span>当前纪律评分</span><strong>{assessedDiscipline(day,settings.riskLimit)??'尚未评价'} / 100</strong></div></div>
      <WellbeingFields key={'wellbeing'+day.date} day={day} onChange={w=>mutate(d=>({...d,wellbeing:{...w,...(d.wellbeing?.trigger!==undefined?{trigger:d.wellbeing.trigger}:{})}}))} onTriggerDraft={v=>mutate(d=>({...d,wellbeing:{...d.wellbeing,trigger:v}}),false)} onTextCommit={commitText}/>
      <div className="form-section"><h3><span>05</span>一句话复盘</h3><BufferedText key={'note'+day.date} label="今天做对了什么？下一次要守住什么？" value={day.note} rows={4} placeholder="没有交易也可以写：等待一小时确认，没有为了回本或怕踏空而主动出手。" onDraft={v=>text('note',v)} onCommit={commitText}/></div>
      </div>{outside&&<p className="warning-note">此日位于验证期外，保存后作为参考记录。</p>}{error&&<div role="alert" className="error-banner">{error}</div>}
      {!demo&&<div className="form-section"><button type="button" className="icon-text" onClick={()=>void tradeAPI<{history:HistoryEntry[]}>('/api/history?type=daily&id='+day.date).then(d=>setHistory(d.history)).catch(e=>setError(e.message))}>读取这一天的修改历史</button><HistoryPanel entries={history}/></div>}
    </div><div className="modal-actions sticky"><span>{demo?'示例数据':'正式验证'} · {day.date}</span><button type="button" className="button secondary" onClick={()=>void close()}>{demo?'取消':'关闭 · 保留草稿'}</button><button className="button primary" type="submit">{mode==='quick'?'保存打卡':'核对并提交'}<Check size={16}/></button></div></fieldset></form>}
  </div></div>;
}
