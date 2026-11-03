import { DEMO_SETTINGS } from './demo-settings.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as domain from '../lib/domain.ts';
import * as trading from '../lib/trading.ts';
import * as calculations from '../lib/calculations.ts';
import * as g1 from '../lib/g1.ts';
import * as g1Schema from '../lib/g1-schema.ts';
import * as vnext from '../lib/vnext.ts';
import * as multiAsset from '../lib/multi-asset.ts';

const example=instrument=>({...trading.blankTrade('2026-10-20'),instrument,symbol:instrument+'-REAL',accountId:'legacy',revision:2,openedTime:'09:12:34',direction:'short',entryPrice:100,quantity:4,initialRisk:24,rationale:'已保存原始依据',closes:[]});
const settle=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
function harness(initial,{mode='list',confirm=true,positionsOnly=false}={}){
  const slots=[],effects=[],writes=[],changed=[],confirmations=[],controls={confirm,rejectNext:false},document={activeElement:null,body:{style:{overflow:'auto'}}};let cursor=0,tree,serverTrade=structuredClone(initial),childMounted=false;
  const react={createElement(type,props,...children){return {type,props:{...props,children}};},useMemo(fn){return fn();},useState(value){const i=cursor++;slots[i]??={value:typeof value==='function'?value():value};return [slots[i].value,next=>{slots[i].value=typeof next==='function'?next(slots[i].value):next;}];},useRef(value){return slots[cursor++]??={current:value};},useEffect(fn,deps){const i=cursor++,old=slots[i];if(!old||deps.some((v,j)=>!Object.is(v,old.deps[j])))effects.push(()=>{old?.cleanup?.();slots[i]={deps,cleanup:fn()};});}};
  const libs={domain,trading,calculations,g1,'g1-schema':g1Schema,vnext,'multi-asset':multiAsset},module={exports:{}};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../app/trade-workspace.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText,{
    exports:module.exports,structuredClone,crypto,Date,Intl,JSON,Error,document,window:{confirm(message){confirmations.push(message);return controls.confirm;},addEventListener(){},removeEventListener(){}},
    require(name){if(name==='react')return react;if(name==='lucide-react')return new Proxy({},{get:(_,key)=>String(key)});const key=name.split('/').at(-1);if(libs[key])return libs[key];if(key==='use-dialog-focus')return {useDialogFocus:()=>({current:null})};if(key==='wellbeing-fields')return {BufferedText:'BufferedText',ReadinessCheck:'ReadinessCheck'};if(key==='trade-calculation-fields')return {PlanPreview:'PlanPreview',PositionSummary:'PositionSummary',ClosePreview:'ClosePreview',TradeFeeFields:'TradeFeeFields'};if(key==='multi-asset-fields')return {MultiAssetIdentityFields:'MultiAssetIdentityFields'};if(key==='g1-fields')return {G1TradeFields:'G1TradeFields'};if(key==='vnext-fields')return {AdditionalTargets:'AdditionalTargets',CloseReasons:'CloseReasons',EntrySnapshotFields:'EntrySnapshotFields',HistoricalSupplementFields:'HistoricalSupplementFields',QuickClassification:'QuickClassification',RiskAcknowledgement:'RiskAcknowledgement',VNextPsychology:'VNextPsychology'};throw Error(name);},
    async fetch(url,options={}){
      if(options.method==='PATCH'){
        const body=JSON.parse(options.body);writes.push({url,method:options.method,body});if(controls.rejectNext){controls.rejectNext=false;return {ok:false,json:async()=>({error:'这笔交易已被更新，请重新读取。'})};}
        serverTrade={...serverTrade,archived:body.action==='trash',revision:serverTrade.revision+1};return {ok:true,json:async()=>({trade:structuredClone(serverTrade)})};
      }
      return {ok:true,json:async()=>({trade:structuredClone(serverTrade),images:[],history:[]})};
    },
  });
  const nodes=node=>Array.isArray(node)?node.flatMap(nodes):!node||typeof node!=='object'?[]:[node,...nodes(node.props?.children)];
  const text=node=>Array.isArray(node)?node.map(text).join(''):typeof node==='string'||typeof node==='number'?String(node):node&&typeof node==='object'?text(node.props?.children):'';
  function render(){
    cursor=0;const root=mode==='list'?module.exports.TradeList({trades:[initial],images:[],newTrade(){},openTrade(){},openDay(){},positionsOnly,onChanged:trade=>changed.push(trade)}):module.exports.TradeDialog({initial,settings:DEMO_SETTINGS,onClose(){},onSaved:trade=>changed.push(trade),onOpenDay(){},onImagesChanged(){}}),rootHooks=cursor;let childNow=false;
    function expand(node){
      if(Array.isArray(node))return node.map(expand);if(!node||typeof node!=='object')return node;
      if(typeof node.type==='function'&&node.type.name==='TradeTrashConfirmation'){childNow=true;return expand(node.type(node.props));}
      const result={...node,props:{...node.props,children:expand(node.props.children)}};
      if(typeof result.type==='string'){result.dom={node:result,focus(){document.activeElement=this;},querySelectorAll(){return nodes(result).filter(child=>child.type==='button'&&!child.props.disabled).map(child=>child.dom);}};if(result.props.ref)result.props.ref.current=result.dom;}
      return result;
    }
    tree=expand(root);if(childMounted&&!childNow){for(const slot of slots.slice(rootHooks))slot?.cleanup?.();slots.length=rootHooks;}childMounted=childNow;while(effects.length)effects.shift()();return tree;
  }
  const find=(type,predicate=()=>true)=>nodes(tree).find(node=>node.type===type&&predicate(node.props,node));
  const button=label=>{const result=find('button',(_props,node)=>text(node).trim()===label);assert.ok(result,'Missing button '+label);return result;};
  async function click(element){const target=typeof element==='string'?button(element):element;document.activeElement=target.dom;target.props.onClick();await settle();render();}
  async function key(key,shiftKey=false){const alert=find('div',props=>props.role==='alertdialog');assert.ok(alert);const event={key,keyCode:key==='Escape'?27:9,shiftKey,nativeEvent:{isComposing:false},preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;}};alert.props.onKeyDown(event);await settle();if(key==='Escape')render();return event;}
  return {render,find,button,nodes:()=>nodes(tree),text:()=>text(tree),click,key,writes,changed,confirmations,controls,get focused(){return text(document.activeElement?.node).trim();},get overflow(){return document.body.style.overflow;},get current(){return slots[0].value;},async ready(){await settle();render();}};
}

test('each instrument has a working list delete, explicit identity confirmation, trash view and one-click restoration',async()=>{
  for(const instrument of ['XAU','NQ','BTC']){
    const original=example(instrument),h=harness(original);h.render();const remove=h.find('button',props=>props['aria-label']==='删除交易 '+original.id);assert.ok(remove);await h.click(remove);
    assert.equal(h.writes.length,0);const confirmation=h.find('div',props=>props.role==='alertdialog');assert.ok(confirmation);assert.equal(confirmation.props['aria-modal'],'true');assert.match(h.text(),new RegExp(instrument));assert.match(h.text(),/2026-10-20 09:12:34/);assert.ok(h.text().includes(original.id));assert.equal(h.focused,'取消');await h.click('删除并移入回收站');
    assert.equal(h.writes.length,1);assert.equal(h.writes[0].method,'PATCH');assert.deepEqual(h.writes[0].body,{id:original.id,revision:original.revision,action:'trash'});assert.equal(h.confirmations.length,0);
    assert.equal(h.changed[0].archived,true);assert.equal(h.find('article'),undefined);await h.click('回收站 (1)');assert.ok(h.find('article'));assert.match(h.text(),/不计入统计/);
    await h.click('恢复交易');assert.equal(h.writes.length,2);assert.equal(h.writes[1].body.action,'restore');assert.equal(h.changed[1].archived,false);assert.equal(h.confirmations.length,0);assert.equal(h.find('article'),undefined);
    await h.click('正常交易');assert.ok(h.find('article'));assert.deepEqual(h.changed[1].closes,original.closes);assert.equal(h.changed[1].initialRisk,24);
  }
});

test('cancelled or failed list deletion leaves the original record visible and does not notify statistics of a change',async()=>{
  const original=example('NQ'),h=harness(original);h.render();await h.click(h.find('button',props=>props['aria-label']==='删除交易 '+original.id));await h.click('取消');assert.equal(h.find('div',props=>props.role==='alertdialog'),undefined);assert.equal(h.writes.length,0);assert.equal(h.changed.length,0);assert.ok(h.find('article'));
  h.controls.rejectNext=true;await h.click(h.find('button',props=>props['aria-label']==='删除交易 '+original.id));await h.click('删除并移入回收站');assert.equal(h.changed.length,0);assert.ok(h.find('article'));assert.ok(h.find('div',props=>props.role==='alertdialog'));assert.match(h.text(),/已被更新/);assert.equal(h.confirmations.length,0);
});

test('the positions-page trash also shows deleted closed trades so they remain recoverable',async()=>{
  const h=harness({...example('BTC'),archived:true,status:'closed'},{positionsOnly:true});h.render();assert.equal(h.find('article'),undefined);await h.click('回收站 (1)');assert.ok(h.find('article'));assert.ok(h.button('恢复交易'));
});

test('detail delete and restore update saved state and preserve prior data rather than submitting unsaved edits',async()=>{
  const initial=example('NQ'),h=harness(initial,{mode:'dialog'});h.render();await h.ready();const rationale=h.find('BufferedText',props=>props.label==='为什么选择这笔交易');rationale.props.onDraft('尚未保存的修改');await h.click('删除交易');
  assert.match(h.text(),/未保存的编辑不会写入/);assert.equal(h.writes.length,0);assert.ok(h.find('div',props=>props.role==='alertdialog'));await h.click('删除并移入回收站');assert.equal(h.writes.length,1);assert.deepEqual(h.writes[0].body,{id:initial.id,revision:initial.revision,action:'trash'});assert.equal(h.current.archived,true);assert.equal(h.current.rationale,'已保存原始依据');assert.match(h.text(),/不参与常规收益、纪律和持仓统计/);
  assert.ok(h.find('fieldset',props=>props.disabled===true));await h.click('恢复交易');assert.equal(h.current.archived,false);assert.equal(h.current.rationale,'已保存原始依据');assert.equal(h.changed.length,2);assert.equal(h.confirmations.length,0);assert.equal(h.writes[1].body.revision,initial.revision+1);
});

test('the shared confirmation focuses cancel, traps Tab and lets Escape cancel without touching browser dialogs or the parent detail',async()=>{
  for(const mode of ['list','dialog']){
    const original=example('BTC'),h=harness(original,{mode});h.render();await h.ready();await h.click(mode==='list'?h.find('button',props=>props['aria-label']==='删除交易 '+original.id):'删除交易');
    assert.equal(h.focused,'取消');assert.equal(h.overflow,'hidden');const reverse=await h.key('Tab',true);assert.equal(reverse.prevented,true);assert.equal(reverse.stopped,true);assert.equal(h.focused,'删除并移入回收站');const forward=await h.key('Tab');assert.equal(forward.prevented,true);assert.equal(h.focused,'取消');
    const escape=await h.key('Escape');assert.equal(escape.prevented,true);assert.equal(escape.stopped,true);assert.equal(h.find('div',props=>props.role==='alertdialog'),undefined);assert.equal(h.writes.length,0);assert.equal(h.changed.length,0);assert.equal(h.confirmations.length,0);assert.equal(h.overflow,'auto');assert.equal(h.focused,'删除交易');
  }
});
