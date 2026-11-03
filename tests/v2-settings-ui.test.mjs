import { DEMO_SETTINGS } from './demo-settings.mjs';
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
import * as multiAsset from '../lib/multi-asset.ts';
import * as calculations from '../lib/calculations.ts';
import * as g1 from '../lib/g1.ts';
import * as g1Schema from '../lib/g1-schema.ts';
import * as vnext from '../lib/vnext.ts';
import * as vnextSchema from '../lib/vnext-schema.ts';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),native=createRequire(import.meta.url),cache=new Map();
const libraries={domain,trading,'multi-asset':multiAsset,calculations,g1,'g1-schema':g1Schema,vnext,'vnext-schema':vnextSchema};
function load(path){
 if(cache.has(path))return cache.get(path);const module={exports:{}};cache.set(path,module.exports);
 runInNewContext(ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText,{exports:module.exports,crypto,structuredClone,Date,Intl,URL,setTimeout,clearTimeout,require(name){if(name==='recharts')return new Proxy({},{get:()=>({children})=>React.createElement('div',null,children)});if(!name.startsWith('.'))return native(name);const base=name.split('/').at(-1).replace(/\.tsx?$/,'');if(libraries[base])return libraries[base];const file=resolve(dirname(path),name);return load(existsSync(file)?file:existsSync(file+'.tsx')?file+'.tsx':file+'.ts');}});cache.set(path,module.exports);return module.exports;
}
const contract={confirmed:true,currency:'USD',settlement:'linear',usdPerPriceUnit:1,entryFeePerQty:null,exitFeePerQty:null,slippagePrice:null,quantityStep:1};
// Demo: all test settings and transaction amounts are fictional.
const demoAccount={...multiAsset.DEFAULT_UNIFIED_ACCOUNT,capital:20000,ledgerUnitCorrection:{confirmed:true,labels:['USD','USDT','UNKNOWN'],source:'Demo explicit fictional ledger correction'}};
const settings={...DEMO_SETTINGS,capital:20000,accountCurrency:'USD',g1:{...g1Schema.DEFAULT_G1,contract},multiAsset:{unifiedAccount:demoAccount,instruments:{XAU:{symbol:'XAUUSDT.P',contract},NQ:{symbol:'QQQUSDT.P',contract},BTC:{symbol:'BTCUSDT.P',contract}}}};

test('daily identity keeps the same simple instrument selector for all three assets and folds technical configuration',()=>{
 const {MultiAssetIdentityFields}=load(root+'/app/multi-asset-fields.tsx');
 for(const instrument of multiAsset.INSTRUMENTS){
  const trade={...trading.blankTrade(),instrument,symbol:settings.multiAsset.instruments[instrument].symbol,contract};
  const markup=renderToStaticMarkup(React.createElement(MultiAssetIdentityFields,{trade,settings,selection:instrument,select(){},locked:false,change(){},read:()=>trade,commit(){}}));
  const daily=markup.split('<details')[0];assert.match(daily,/交易品种/);assert.match(daily,/原黄金账户 · USD/);assert.doesNotMatch(daily,/交易账户编号|报价来源|每1数量|手续费估算规则|结算类型|UNKNOWN/);assert.equal((daily.match(/<select/g)??[]).length,1);
  assert.match(markup,/<details class="form-section"><summary>高级：合约参数与原始记录/);assert.doesNotMatch(markup,/<details[^>]+open/);
 }
});

test('one-time settings retain one USD account without adding accounts or exposing a daily currency picker',()=>{
 const {MultiAssetSettingsForm}=load(root+'/app/multi-asset-workspace.tsx'),before=JSON.stringify(settings);
 const markup=renderToStaticMarkup(React.createElement(MultiAssetSettingsForm,{settings,save:async()=>{},disabled:false}));
 assert.match(markup,/统一账户与合约设置/);assert.match(markup,/20,000 USD/);assert.match(markup,/不是当前余额/);assert.doesNotMatch(markup,/增加账户|默认账户|账户 ID|汇总基准币种|UNKNOWN/);assert.match(markup,/高级：合约规格与预计交易成本/);assert.equal(JSON.stringify(settings),before);
});

test('a known short price risk remains visible while missing estimated costs are explained only once',()=>{
 const {PlanPreview}=load(root+'/app/trade-calculation-fields.tsx');
 const trade={...trading.blankTrade('2026-10-20'),instrument:'NQ',symbol:'QQQUSDT.P',accountId:'demo-account',direction:'short',entryPrice:100,quantity:6,originalStop:104,targetPrice:91,aggregateEntryFee:3,contract};
 const markup=renderToStaticMarkup(React.createElement(PlanPreview,{trade,settings}));
 assert.match(markup,/止损毛风险<\/span><strong>24.00 USD/);assert.match(markup,/目标毛收益<\/span><strong>54.00 USD/);assert.match(markup,/1 : 2.25/);assert.match(markup,/3.00 USD/);assert.match(markup,/已知风险下界<\/span><strong>27.00 USD \+ 费用\/滑点/);assert.match(markup,/至少 0.14%/);assert.match(markup,/补齐剩余费用及滑点后显示完整净风险/);assert.doesNotMatch(markup,/UNKNOWN|参数待补充|预算待核实/);
});

test('an empty trade never presents an unentered opening fee as a real zero',()=>{
 const {PlanPreview,PositionSummary}=load(root+'/app/trade-calculation-fields.tsx'),trade={...trading.blankTrade(),instrument:'NQ',contract};
 const preview=renderToStaticMarkup(React.createElement(PlanPreview,{trade,settings})),position=renderToStaticMarkup(React.createElement(PositionSummary,{trade,settings}));
 assert.match(preview,/已录开仓手续费<\/span><strong>未录 USD/);assert.doesNotMatch(preview,/已录开仓手续费<\/span><strong>0.00/);assert.match(position,/开仓费用<\/span><strong>未录 USD/);assert.match(position,/总手续费<\/span><strong>未录 USD/);
 const zero=renderToStaticMarkup(React.createElement(PlanPreview,{trade:{...trade,aggregateEntryFee:0},settings}));assert.match(zero,/已录开仓手续费<\/span><strong>0.00 USD/);
});

test('the unique account equity card keeps all three instruments when a contribution filter changes',()=>{
 const {MultiAssetWorkspace}=load(root+'/app/multi-asset-workspace.tsx');
 const saved=(id,instrument,net,date)=>trading.syncStatus({...trading.blankTrade('2026-10-20'),id,instrument,symbol:settings.multiAsset.instruments[instrument].symbol,accountId:instrument,contract,direction:'long',entryPrice:100,quantity:1,aggregateEntryFee:0,closes:[{id:id+'-close',date,time:'10:00:00',quantity:1,price:110,fees:0,netPnl:net,reason:'隔离UI验算',calculationMode:'reported'}]});
 const trades=[saved('x','XAU',100,'2026-10-21'),saved('n','NQ',200,'2026-10-22'),saved('b','BTC',-50,'2026-10-23')];
 for(const instrument of ['all','XAU','NQ','BTC']){
  const markup=renderToStaticMarkup(React.createElement(MultiAssetWorkspace,{trades,records:[],settings,instrument,start:'2026-10-10',end:'2026-10-31',openTrade(){}}));
  const account=markup.match(/<section class="card" aria-label="统一账户概览">([\s\S]*?)<\/section>/)?.[1];assert.ok(account);assert.match(account,/20,250.00 USD/);assert.match(account,/250.00 USD/);assert.equal((markup.match(/aria-label="统一账户概览"/g)??[]).length,1);
 }
});

test('the dashboard currency warning respects confirmed ledger corrections while preserving real foreign-currency warnings',()=>{
 const dashboardSource=ts.transpileModule(readFileSync(root+'/app/dashboard.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
 function warnings(trades,currentSettings=settings){
  let suppliedTrades=false,suppliedSettings=false;
  // Inject only the loaded account snapshot; child components and effects do not run.
  const react={...React,createElement:(type,props,...children)=>({type,props:{...props,children}}),useState(value){let initial=typeof value==='function'?value():value;if(!suppliedTrades&&Array.isArray(initial)){initial=trades;suppliedTrades=true;}else if(!suppliedSettings&&initial?.capital&&initial?.start){initial=currentSettings;suppliedSettings=true;}return [initial,()=>{}];},useMemo:fn=>fn(),useRef:value=>({current:value}),useEffect(){},useLayoutEffect(){}};
  const module={exports:{}};
  runInNewContext(dashboardSource,{exports:module.exports,crypto,structuredClone,Date,Intl,URL,Blob,setTimeout,clearTimeout,require(name){if(name.endsWith('.css'))return {};if(name==='react')return react;if(!name.startsWith('.'))return native(name);const key=name.split('/').at(-1).replace(/\.tsx?$/,'');if(libraries[key])return libraries[key];const file=resolve(root+'/app',name);return load(existsSync(file)?file:existsSync(file+'.tsx')?file+'.tsx':file+'.ts');}});
  const nodes=node=>Array.isArray(node)?node.flatMap(nodes):node&&typeof node==='object'?[node,...nodes(node.props?.children)]:[];
  return nodes(module.exports.default()).filter(node=>node.type==='p'&&node.props.className==='warning-note'&&node.props.children.includes('账户统计按 '));
 }
 const saved=(id,currency,archived=false)=>({...trading.blankTrade(),id,instrument:'NQ',accountId:'legacy',entryPrice:100,quantity:1,contract:{...contract,currency},archived});
 const corrected=[saved('stablecoin-label','USDT'),saved('old-missing-label','UNKNOWN')],before=JSON.stringify(corrected);
 assert.equal(warnings(corrected).length,0);assert.equal(JSON.stringify(corrected),before);
 assert.equal(warnings([...corrected,saved('actual-cny','CNY')]).length,1);
 assert.equal(warnings([...corrected,saved('archived-cny','CNY',true)]).length,0);
 const unconfirmed={...settings,multiAsset:{...settings.multiAsset,unifiedAccount:{...settings.multiAsset.unifiedAccount,ledgerUnitCorrection:{...settings.multiAsset.unifiedAccount.ledgerUnitCorrection,confirmed:false}}}};
 assert.equal(warnings(corrected,unconfirmed).length,1);
});
