import { DEMO_SETTINGS } from './demo-settings.mjs';
import * as multiAsset from '../lib/multi-asset.ts';
import * as vnext from '../lib/vnext.ts';
import * as vnextSchema from '../lib/vnext-schema.ts';
import * as calculations from '../lib/calculations.ts';
import * as g1Real from '../lib/g1.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as domain from '../lib/domain.ts';
import * as trading from '../lib/trading.ts';

test('independent editor buffers long text locally and saves the final character, without touching another trade or daily state',async()=>{
  const initial={...trading.blankTrade('2026-10-10'),initialRisk:100,quantity:3},slots=[],effects=[],saved=[],writes=[];let cursor=0,tree,parentRenders=0;
  const react={createElement(type,props,...children){return {type,props:{...props,children}};},useState(initial){const i=cursor++;slots[i]??={value:typeof initial==='function'?initial():initial};return [slots[i].value,v=>{slots[i].value=typeof v==='function'?v(slots[i].value):v;if(i===0)parentRenders++;}];},useRef(initial){const i=cursor++;return slots[i]??={current:initial};},useEffect(fn,deps){const i=cursor++,old=slots[i];if(!old||deps.some((v,j)=>!Object.is(v,old.deps?.[j])))effects.push(()=>{old?.cleanup?.();slots[i]={deps,cleanup:fn()};});}};
  const source=readFileSync(new URL('../app/trade-workspace.tsx',import.meta.url),'utf8'),module={exports:{}};
  runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText,{exports:module.exports,structuredClone,crypto,window:{confirm:()=>true,addEventListener(){},removeEventListener(){}},require(name){if(name.endsWith('multi-asset'))return multiAsset;if(name.endsWith('multi-asset-fields'))return {MultiAssetIdentityFields:'MultiAssetIdentityFields',IndependentClassification:'IndependentClassification'};if(name.endsWith('/vnext'))return vnext;if(name.endsWith('vnext-fields'))return {AdditionalTargets:'AdditionalTargets',CloseReasons:'CloseReasons',EntrySnapshotFields:'EntrySnapshotFields',HistoricalSupplementFields:'HistoricalSupplementFields',QuickClassification:'QuickClassification',RiskAcknowledgement:'RiskAcknowledgement',VNextPsychology:'VNextPsychology'};if(name.endsWith('calculations'))return calculations;if(name.endsWith('/g1'))return g1Real;if(name.endsWith('trade-calculation-fields'))return {PlanPreview:'PlanPreview',PositionSummary:'PositionSummary',ClosePreview:'ClosePreview'};if(name.endsWith('quick-checkin'))return {QuickCheckin:'QuickCheckin',DailyAutoSummary:'DailyAutoSummary'};if(name==='react')return react;if(name==='lucide-react')return new Proxy({},{get:(_,key)=>String(key)});if(name.endsWith('/domain'))return domain;if(name.endsWith('/trading'))return trading;if(name.endsWith('g1-schema'))return {blankG1:()=>({})};if(name.endsWith('g1-fields'))return {G1TradeFields:'G1TradeFields',PsychologyFields:'PsychologyFields'};if(name.endsWith('wellbeing-fields'))return {BufferedText:'BufferedText',ReadinessCheck:'ReadinessCheck'};if(name.endsWith('use-dialog-focus'))return {useDialogFocus:()=>({current:null})};throw Error(name);},async fetch(url,options){if(options.method==='PUT'){const value=JSON.parse(options.body);writes.push({url,value});return {ok:true,json:async()=>({trade:{...value,revision:1}})};}return {ok:true,json:async()=>({history:[]})};}});
  function render(){cursor=0;tree=module.exports.TradeDialog({initial,settings:DEMO_SETTINGS,onClose(){},onSaved:t=>saved.push(t),onOpenDay(){},onImagesChanged(){}});while(effects.length)effects.shift()();}
  function nodes(n){if(n===undefined)return [];if(Array.isArray(n))return n.flatMap(nodes);if(!n||typeof n!=='object')return [];return [n,...nodes(n.props?.children)];}
  render();nodes(tree).find(n=>n.type==='MultiAssetIdentityFields').props.select('XAU');render();const field=nodes(tree).find(n=>n.type==='BufferedText'&&n.props.label==='为什么选择这笔交易').props;
  const count=parentRenders;field.onDraft('中');field.onDraft('中文结构观察。'.repeat(300)+'最后一个字。');assert.equal(parentRenders,count);
  await nodes(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});
  assert.equal(saved.length,1);assert.equal(saved[0].rationale,'中文结构观察。'.repeat(300)+'最后一个字。');assert.equal(writes.length,1);assert.equal(writes[0].url,'/api/trades');assert.equal(saved[0].id,initial.id);assert.deepEqual(saved[0].closes,[]);assert.equal(saved[0].revision,1);
  slots.forEach(s=>s.cleanup?.());
});
