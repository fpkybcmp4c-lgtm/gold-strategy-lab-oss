import { DEMO_SETTINGS } from './demo-settings.mjs';
import * as vnext from '../lib/vnext.ts';
import * as multiAsset from '../lib/multi-asset.ts';
import * as vnextSchema from '../lib/vnext-schema.ts';
import * as calculations from '../lib/calculations.ts';
import * as g1Real from '../lib/g1.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import * as domain from '../lib/domain.ts';
import * as trading from '../lib/trading.ts';
import * as g1 from '../lib/g1.ts';
import * as g1Schema from '../lib/g1-schema.ts';
import * as stats from '../lib/g1-stats.ts';
import * as opportunities from '../lib/opportunities.ts';
import * as wellbeing from '../lib/wellbeing.ts';
const uiDomain={...domain,todayCN:()=> '2026-10-11'};
const native=createRequire(import.meta.url),root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),cache=new Map(),libs={'multi-asset':multiAsset,vnext,'vnext-schema':vnextSchema,calculations,domain:uiDomain,trading,g1,'g1-schema':g1Schema,'g1-stats':stats,opportunities,wellbeing};
function load(path){if(cache.has(path))return cache.get(path);const module={exports:{}},source=readFileSync(path,'utf8');cache.set(path,module.exports);runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText,{exports:module.exports,crypto,structuredClone,Date,Intl,URL,setTimeout,clearTimeout,require(name){if(!name.startsWith('.'))return native(name);const base=name.split('/').at(-1).replace(/\.tsx?$/, '');if(libs[base])return libs[base];const file=resolve(dirname(path),name);return load(existsSync(file)?file:existsSync(file+'.tsx')?file+'.tsx':file+'.ts');}});cache.set(path,module.exports);return module.exports;}
const s={...DEMO_SETTINGS,riskLimit:400};

test('G1 load-current-settings uses the selected instrument contract for NQ and BTC',()=>{
  const {G1TradeFields}=load(root+'/app/g1-fields.tsx');
  for(const instrument of ['NQ','BTC']){
    const contract={confirmed:true,currency:instrument==='BTC'?'USDT':'USD',usdPerPriceUnit:instrument==='NQ'?2:1,entryFeePerQty:2,exitFeePerQty:2,slippagePrice:0,quantityStep:.1};
    const settings={...s,multiAsset:{accounts:[{id:'qa',name:'isolated',currency:contract.currency,capital:10000}],instruments:{[instrument]:{contract,normalRisk:100,riskLimit:200}}}};
    let trade={...trading.blankTrade(),instrument,accountId:'qa',framework:'G1',strategy:'G1-L',direction:'long',entryPrice:100,originalStop:90,quantity:1,contract:{...contract,usdPerPriceUnit:999},g1:{...g1Schema.blankG1(),side:'long',riskBudget:100}};
    const original=JSON.stringify(settings),tree=G1TradeFields({trade,settings,read:()=>trade,change:patch=>{trade={...trade,...patch};},commit(){}});
    const find=node=>{if(!node||typeof node!=='object')return null;if(node.type==='button'&&React.Children.toArray(node.props.children).join('').includes('载入当前设置'))return node;for(const child of React.Children.toArray(node.props?.children)){const result=find(child);if(result)return result;}return null;};
    const button=find(tree);assert(button);button.props.onClick();
    assert.deepEqual(structuredClone(trade.contract),contract);assert.deepEqual(structuredClone(trade.g1.contract),contract);assert.equal(JSON.stringify(settings),original);
  }
});
test('G1 UI renders true empty-state stats, independent opportunities entry and private candidate guidance',()=>{
  const {G1Workspace}=load(root+'/app/g1-workspace.tsx'),html=renderToStaticMarkup(React.createElement(G1Workspace,{trades:[],records:[],settings:s,opportunities:[],disabled:false,newTrade(){},openTrade(){},onOpportunitySaved(){},fromOpportunity(){},openSettings(){}}));assert.match(html,/样本不足/);assert.match(html,/新增G1交易/);assert.match(html,/观察一个机会/);assert.match(html,/MAE/);assert.match(html,/市场状态/);assert.match(html,/没有真实收益路径记录/);assert(!html.includes('已验证的盈利系统'));
});
test('real React trade detail renders multi-entry controls, G1 checklist, missing-price state and persistent screenshot inputs',()=>{
  const {TradeDialog}=load(root+'/app/trade-workspace.tsx'),t={...trading.blankTrade('2026-10-10'),framework:undefined,revision:1,model:'G1',direction:'short',g1:g1Schema.blankG1()},html=renderToStaticMarkup(React.createElement(TradeDialog,{initial:t,settings:s,onClose(){},onSaved(){},onOpenDay(){},onImagesChanged(){}}));assert.match(html,/增加分仓/);assert.match(html,/G1检查与管理/);assert.match(html,/未完成检查/);assert.match(html,/没有实时行情接口/);assert.match(html,/允许|违规仍可保存|违规数据可以保存/);assert.match(html,/image\/png,image\/jpeg,image\/webp/);assert.match(html,/4小时/);
});
test('growth page G1 review receives saved trades and independent opportunities',()=>{
  const {PersonalGrowth}=load(root+'/app/personal-growth.tsx'),today=uiDomain.todayCN(),settings={...s,start:domain.addDays(today,-30),end:domain.addDays(today,30)},date=domain.addDays(today,-1),day=domain.blankDay(date),t={...trading.blankTrade(date),framework:undefined,model:'G1',direction:'short',inPlan:false,quantity:1,entryPrice:2500,initialRisk:100,status:'closed',closes:[{id:'real-close',date,time:'12:00:00',quantity:1,price:2250,fees:0,netPnl:250,reason:'真实净额'}]},o={...opportunities.blankOpportunity(settings),date};
  const expected=stats.g1Review([t],[day],[o],settings,domain.periodKey(today,'week'),date);
  const html=renderToStaticMarkup(React.createElement(PersonalGrowth,{records:[day],rawRecords:[day],trades:[t],images:[],opportunities:[o],settings,exportAll(){}}));
  assert.match(html,new RegExp('机会 / 合格未执行</span><strong>'+expected.observedCount+' / '+expected.notExecutedCount+'</strong>'));
  assert.match(html,new RegExp('合规 / 违规 / 待补充</span><strong>'+expected.stats.compliant+' / '+expected.stats.violated+' / '+expected.stats.unknown+'</strong>'));
  if(expected.stats.knownR)assert.match(html,/平均净R \/ 上期<\/span><strong>2\.50 \/ —<\/strong>/);
});
test('embedded Sunday G1 review uses the same completed-date cutoff as its weekly export',()=>{
  const {SundayReview}=load(root+'/app/personal-growth.tsx'),today=uiDomain.todayCN(),settings={...s,start:domain.addDays(today,-30),end:domain.addDays(today,30)},t={...trading.blankTrade(today),framework:undefined,model:'G1',direction:'short',inPlan:false,quantity:1,entryPrice:2500,initialRisk:100},o={...opportunities.blankOpportunity(settings),date:today};
  const html=renderToStaticMarkup(React.createElement(SundayReview,{records:[],trades:[t],images:[],opportunities:[o],settings,rawRecords:[]}));
  assert.match(html,/机会 \/ 合格未执行<\/span><strong>0 \/ 0<\/strong>/);
  assert.match(html,/合规 \/ 违规 \/ 待补充<\/span><strong>0 \/ 0 \/ 0<\/strong>/);
});
test('legacy zero-risk records retain net amounts but never display infinite R in cards or details',()=>{
  const {TradeList,TradeDialog}=load(root+'/app/trade-workspace.tsx'),t=trading.legacyTrade(domain.todayCN(),{id:'old-zero-risk',model:'S1',inPlan:true,netPnl:100,initialRisk:0});
  const card=renderToStaticMarkup(React.createElement(TradeList,{trades:[t],images:[],newTrade(){},openTrade(){},openDay(){}})),detail=renderToStaticMarkup(React.createElement(TradeDialog,{initial:t,settings:s,onClose(){},onSaved(){},onOpenDay(){},onImagesChanged(){}}));
  assert.match(card,/\+100\.00 USD/);assert.match(card,/ \/ —<\/strong>/);assert.match(detail,/整笔R —/);assert(!card.includes('∞')&&!detail.includes('∞')&&!card.includes('Infinity')&&!detail.includes('NaN'));
});

test('explicit G1 contract edits update the shared risk snapshot without resetting historical 1R',()=>{
  const {G1TradeFields,ContractFields}=load(root+'/app/g1-fields.tsx');
  const contract={confirmed:true,usdPerPriceUnit:1,entryFeePerQty:1,exitFeePerQty:1,slippagePrice:0,quantityStep:.1};
  let t={...trading.blankTrade('2026-10-11'),framework:undefined,strategy:'G1-S',direction:'short',entryPrice:100,quantity:2,originalStop:110,currentStop:110,initialRisk:20,contract,g1:{...g1Schema.blankG1(),contract}};
  const before=JSON.stringify(s),tree=G1TradeFields({trade:t,settings:s,read:()=>t,change:patch=>{t={...t,...patch};},commit(){}});
  function find(node){if(!node||typeof node!=='object')return null;if(node.type===ContractFields)return node;for(const child of React.Children.toArray(node.props?.children)){const found=find(child);if(found)return found;}return null;}
  find(tree).props.onChange({...contract,exitFeePerQty:3});
  assert.equal(t.contract.exitFeePerQty,3);assert.equal(t.g1.contract.exitFeePerQty,3);assert.equal(calculations.planCalculation(t,s).totalRisk,28);assert.equal(t.initialRisk,20);assert.equal(JSON.stringify(s),before);
});
