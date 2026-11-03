import { DEMO_SETTINGS } from './demo-settings.mjs';
import * as vnext from '../lib/vnext.ts';
import * as vnextSchema from '../lib/vnext-schema.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as domain from '../lib/domain.ts';
import * as trading from '../lib/trading.ts';
import * as calculations from '../lib/calculations.ts';
import * as g1 from '../lib/g1.ts';
import * as schema from '../lib/g1-schema.ts';
import * as stats from '../lib/g1-stats.ts';
import * as opportunities from '../lib/opportunities.ts';
import * as wellbeing from '../lib/wellbeing.ts';
import * as ledger from '../lib/ledger.ts';
import * as exportsLib from '../lib/exports.ts';
const native=createRequire(import.meta.url),root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const libs={vnext,'vnext-schema':vnextSchema,domain,trading,calculations,g1,'g1-schema':schema,'g1-stats':stats,opportunities,wellbeing,ledger,exports:exportsLib};
function loader(react=React,custom={}){
  const cache=new Map();return function load(path){if(cache.has(path))return cache.get(path);const module={exports:{}};cache.set(path,module.exports);runInNewContext(ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText,{exports:module.exports,crypto,structuredClone,Date,Intl,URL,Blob,setTimeout,clearTimeout,...custom,require(name){if(name.endsWith('.css'))return {};if(name==='react')return react;if(!name.startsWith('.'))return native(name);const key=name.split('/').at(-1).replace(/\.tsx?$/, '');if(libs[key])return libs[key];const file=resolve(dirname(path),name);return load(existsSync(file)?file:existsSync(file+'.tsx')?file+'.tsx':file+'.ts');}});cache.set(path,module.exports);return module.exports;};
}
const settings={...DEMO_SETTINGS,riskLimit:400};
test('V6 UI: actual React home has exactly four navigation destinations and optional data explanation',()=>{
  const Dashboard=loader()(root+'/app/dashboard.tsx').default,html=renderToStaticMarkup(React.createElement(Dashboard));const nav=html.slice(html.indexOf('<nav'),html.indexOf('</nav>'));assert.equal((nav.match(/class="nav-item/g)??[]).length,4);for(const label of ['首页','记录','分析','设置'])assert(nav.includes(label));assert.match(html,/<details class="mode-banner live"><summary>数据范围与统计口径/);assert.match(html,/今日快速打卡/);assert.match(html,/多品种交易验证/);assert(!html.includes('Infinity'));
});
test('V6 UI: G1-L with L1 keeps its model, renders mirror checklist and never claims a verified edge',()=>{
  const TradeDialog=loader()(root+'/app/trade-workspace.tsx').TradeDialog,t={...trading.blankTrade(),model:'L1',direction:'long',framework:undefined,strategy:'G1-L',g1:{...schema.blankG1(),side:'long'}};const html=renderToStaticMarkup(React.createElement(TradeDialog,{initial:t,settings,onClose(){},onSaved(){},onOpenDay(){},onImagesChanged(){}}));assert.match(html,/G1-L · 顺势回踩支撑做多/);assert.match(html,/HH \/ HL 上涨结构/);assert.match(html,/预先标记的支撑下界/);assert.match(html,/回踩转强/);assert.match(html,/G1检查与管理/);assert.match(html,/高级信息、成交时间与历史更正/);assert.match(html,/实际成交/);
});
test('V6 UI: quick check-in permits optional note and true no-trade choice without the long detailed form',()=>{
  const {QuickCheckin,blankQuick}=loader()(root+'/app/quick-checkin.tsx'),day={...domain.blankDay(),disciplineAssessed:false,quick:blankQuick()},html=renderToStaticMarkup(React.createElement(QuickCheckin,{day,change(){},text(){},commit(){},read:()=>day,trades:[],settings}));for(const text of ['上涨趋势','下跌趋势','LH/LL','无新增交易','尚未评价','一句话复盘 · 可留空','想回本','疲劳'])assert(html.includes(text));assert(!html.includes('日线详细判断'));assert(!html.includes('required='));
});
test('V6 UI: partial-close shortcut uses current remaining size and recalculation preserves initial risk',async()=>{
  const slots=[],effects=[];let cursor=0,tree;const react={createElement(type,props,...children){return {type,props:{...props,children}};},useState(v){const i=cursor++;slots[i]??={value:typeof v==='function'?v():v};return [slots[i].value,n=>{slots[i].value=typeof n==='function'?n(slots[i].value):n;}];},useRef(v){const i=cursor++;return slots[i]??={current:v};},useEffect(fn,deps){const i=cursor++,old=slots[i];if(!old||deps.some((v,j)=>!Object.is(v,old.deps[j])))effects.push(()=>{old?.cleanup?.();slots[i]={deps,cleanup:fn()};});}};
  react.useLayoutEffect=react.useEffect;
  const contract={confirmed:true,usdPerPriceUnit:1,entryFeePerQty:1,exitFeePerQty:1,slippagePrice:0,quantityStep:.1},initial=trading.syncStatus({...trading.blankTrade('2026-10-11'),revision:1,direction:'short',entryPrice:100,quantity:8,originalStop:110,currentStop:110,initialRisk:100,contract,aggregateEntryFee:8,closes:[{id:'old',date:'2026-10-11',time:'10:00:00',quantity:2,price:90,fees:2,netPnl:16,reason:''}]}),window={confirm:()=>true,addEventListener(){},removeEventListener(){}},document={activeElement:null,body:{style:{}},addEventListener(){},removeEventListener(){}},load=loader(react,{window,document,fetch:async()=>({ok:true,json:async()=>({history:[]})})}),Dialog=load(root+'/app/trade-workspace.tsx').TradeDialog;
  function render(){cursor=0;tree=Dialog({initial,settings:{...settings,g1:{...schema.DEFAULT_G1,contract}},onClose(){},onSaved(){},onOpenDay(){},onImagesChanged(){}});/* read-only network effect is intentionally not executed here */}
  function nodes(n){if(Array.isArray(n))return n.flatMap(nodes);if(!n||typeof n!=='object')return [];return [n,...nodes(n.props?.children)];}
  render();const button=nodes(tree).find(n=>n.type==='button'&&n.props.children.includes('平仓25%'));button.props.onClick();render();assert.equal(slots[0].value.closes.at(-1).quantity,1.5);assert.equal(slots[0].value.initialRisk,100);assert.equal(slots[0].value.closes[0].netPnl,16);
});
test('V6 UI: primary, body and secondary token text reach AA on their actual theme surfaces',()=>{
  const css=readFileSync(root+'/app/globals.css','utf8'),tokens=Object.fromEntries([...(css.match(/:root\{([^}]+)/)?.[1]??'').matchAll(/--([\w-]+):(#[\da-f]{6})/ig)].map(m=>[m[1],m[2]]));
  const luminance=h=>{const c=[1,3,5].map(i=>parseInt(h.slice(i,i+2),16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return .2126*c[0]+.7152*c[1]+.0722*c[2];},contrast=(a,b)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
  assert(contrast('#ffffff',tokens.action)>=4.5);assert(contrast(tokens.muted,tokens.canvas)>=4.5);assert(contrast(tokens.ink,tokens.paper)>=7);assert(contrast(tokens.gold,tokens.selected)>=4.5);assert(css.includes('@media(max-width:760px)'));
});
