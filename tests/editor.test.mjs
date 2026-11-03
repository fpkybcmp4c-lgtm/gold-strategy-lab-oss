import { DEMO_SETTINGS } from './demo-settings.mjs';
import * as calculations from '../lib/calculations.ts';
import * as g1Real from '../lib/g1.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as domain from '../lib/domain.ts';
import { createDraftWriter } from '../lib/draft-writer.ts';

const settle=async()=>{for(let i=0;i<25;i++)await Promise.resolve();};
function harness(initial,records=[]){
  const slots=[],effects=[],drafts=new Map(),writes=[],confirmed=[];let cursor=0,tree,closed=0,dayUpdates=0;
  const react={createElement(type,props,...children){return {type,props:{...props,children}};},useState(initial){const i=cursor++;slots[i]??={value:typeof initial==='function'?initial():initial};return [slots[i].value,v=>{const next=typeof v==='function'?v(slots[i].value):v;if(!Object.is(next,slots[i].value)){slots[i].value=next;if(i===0)dayUpdates++;}}];},useRef(initial){const i=cursor++;return slots[i]??={current:initial};},useEffect(fn,deps){const i=cursor++,old=slots[i];if(!old||deps.some((v,j)=>!Object.is(v,old.deps?.[j])))effects.push(()=>{old?.cleanup?.();slots[i]={deps,cleanup:fn()};});}};
  const source=readFileSync(new URL('../app/day-editor.tsx',import.meta.url),'utf8'),compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText,module={exports:{}};
  runInNewContext(compiled,{exports:module.exports,require(name){if(name.endsWith('calculations'))return calculations;if(name.endsWith('/g1'))return g1Real;if(name.endsWith('trade-calculation-fields'))return {PlanPreview:'PlanPreview',PositionSummary:'PositionSummary',ClosePreview:'ClosePreview'};if(name.endsWith('quick-checkin'))return {QuickCheckin:'QuickCheckin',DailyAutoSummary:'DailyAutoSummary'};if(name==='react')return react;if(name==='lucide-react')return new Proxy({},{get:(_,key)=>String(key)});if(name.endsWith('/domain'))return domain;if(name.endsWith('draft-writer'))return {createDraftWriter};if(name.endsWith('use-dialog-focus'))return {useDialogFocus:()=>({current:null})};if(name.endsWith('trade-workspace'))return {HistoryPanel:'HistoryPanel',tradeAPI:async()=>({history:[]})};if(name.endsWith('wellbeing-fields'))return {BufferedText:'BufferedText',ReadinessCheck:'ReadinessCheck',WellbeingFields:'WellbeingFields'};throw new Error(name);},structuredClone,TextEncoder,crypto,JSON,window:{confirm:()=>true,addEventListener(){},removeEventListener(){}},document:{visibilityState:'visible',addEventListener(){},removeEventListener(){}},async fetch(url,options){const date=new URL(url,'https://private.test').searchParams.get('date');if(options.method==='PUT'){const record=JSON.parse(options.body);drafts.set(date,record);writes.push(record);}if(options.method==='DELETE')drafts.delete(date);return {ok:true,async json(){return options.method==='GET'?{draft:drafts.has(date)?{record:drafts.get(date),updatedAt:'now'}:null}:{ok:true};}};}});
  function render(){cursor=0;tree=module.exports.default({initial,records,settings:DEMO_SETTINGS,demo:false,saving:false,onClose(){closed++;},async save(d){confirmed.push(structuredClone(d));closed++;}});while(effects.length)effects.shift()();return tree;}
  function nodes(node){if(arguments.length===0)node=tree;if(!node||typeof node!=='object')return [];if(Array.isArray(node))return node.flatMap(n=>nodes(n));return [node,...nodes(node.props?.children)];}
  function find(type,predicate=()=>true){return nodes().find(n=>n.type===type&&predicate(n.props))?.props;}
  function cleanup(){slots.forEach(s=>s.cleanup?.());}
  return {render,find,cleanup,writes,confirmed,drafts,get closed(){return closed;},get dayUpdates(){return dayUpdates;}};
}

test('editor confirmation captures uncommitted final text, merges pending trigger text and preserves historical trading fields',async()=>{
  const initial={...domain.blankDay('2026-10-10'),note:'历史复盘',trades:[{id:'legacy',model:'S1',netPnl:100,initialRisk:100,inPlan:true}]};
  const h=harness(initial,[initial]);h.render();await settle();h.render();
  const note=h.find('BufferedText',p=>p.label.includes('今天做对')),state=h.find('WellbeingFields');const before=h.dayUpdates;
  note.onDraft('中');note.onDraft('中文最后一个字。');assert.equal(h.dayUpdates,before);
  state.onTriggerDraft('压力触发事件，末尾。');state.onChange({stress:0,worry:2,energy:7,sleepHours:7.5,exercised:true});
  h.render();h.find('button',p=>p.children.includes('完整复盘')).onClick();h.render();h.find('form').onSubmit({preventDefault(){}});h.render();h.find('button',p=>p.children.includes('确认并保存')).onClick();await settle();
  assert.equal(h.confirmed.length,1);assert.equal(h.confirmed[0].note,'中文最后一个字。');assert.equal(h.confirmed[0].wellbeing.trigger,'压力触发事件，末尾。');assert.equal(h.confirmed[0].wellbeing.stress,0);assert.deepEqual(h.confirmed[0].trades,initial.trades);assert.deepEqual(h.writes.at(-1),h.confirmed[0]);h.cleanup();
});
test('closing a new record flushes the newest draft without confirming it into performance',async()=>{
  const h=harness(domain.blankDay('2026-10-11'));h.render();await settle();h.render();
  h.find('BufferedText',p=>p.label.includes('今天做对')).onDraft('关闭前刚输入的末尾。');h.find('WellbeingFields').onTriggerDraft('没有等待输入停顿。');
  h.render();h.find('button',p=>p['aria-label']==='关闭并保留草稿').onClick();await settle();assert.equal(h.closed,1);assert.equal(h.confirmed.length,0);assert.equal(h.drafts.get('2026-10-11').note,'关闭前刚输入的末尾。');assert.equal(h.drafts.get('2026-10-11').wellbeing.trigger,'没有等待输入停顿。');h.cleanup();
});
