import { DEMO_RISK_RULES } from './demo-settings.mjs';
import { DEMO_SETTINGS } from './demo-settings.mjs';
import * as multiAsset from '../lib/multi-asset.ts';
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
import * as vnextSchema from '../lib/vnext-schema.ts';

const contract={confirmed:true,usdPerPriceUnit:1,entryFeePerQty:1,exitFeePerQty:1,slippagePrice:0,quantityStep:.1,currency:'USD'};
const settings={...DEMO_SETTINGS,accountCurrency:'USD',riskLimit:400,g1:{...g1Schema.DEFAULT_G1,contract},riskRules:DEMO_RISK_RULES};
const settle=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};

// Compile and run the real editor, its new stateless controls and calculation
// previews. Retain hooks; replace only browser APIs, text buffering and G1's
// separate editor. No production storage or live accounts are involved.
function harness(initial={...trading.blankTrade('2026-10-13'),openedTime:'15:00:00',contract},initialAction,testSettings=settings){
  const slots=[],effects=[],writes=[],saved=[],modules=new Map();let cursor=0,tree,closed=0;
  const react={
    Fragment:'Fragment',createElement(type,props,...children){return {type,props:{...props,children}};},
    useState(value){const index=cursor++;slots[index]??={value:typeof value==='function'?value():value};return [slots[index].value,next=>{slots[index].value=typeof next==='function'?next(slots[index].value):next;}];},
    useRef(value){return slots[cursor++]??={current:value};},
    useEffect(fn,deps){const index=cursor++,old=slots[index];if(!old||deps.some((value,i)=>!Object.is(value,old.deps[i])))effects.push(()=>{old?.cleanup?.();slots[index]={deps,cleanup:fn()};});},
  };
  const libs={'multi-asset':multiAsset,domain,trading,calculations,g1,'g1-schema':g1Schema,vnext,'vnext-schema':vnextSchema};
  function load(file){
    if(modules.has(file))return modules.get(file);
    const module={exports:{}};modules.set(file,module.exports);
    const compiled=ts.transpileModule(readFileSync(new URL('../app/'+file+'.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
    runInNewContext(compiled,{
      exports:module.exports,structuredClone,crypto,Date,Intl,JSON,Error,
      window:{confirm:()=>true,addEventListener(){},removeEventListener(){}},
      require(name){
        if(name==='react')return react;
        if(name==='lucide-react')return new Proxy({},{get:(_,key)=>String(key)});
        const key=name.split('/').at(-1).replace(/\.tsx?$/,'');
        if(libs[key])return libs[key];
        if(key==='wellbeing-fields')return {BufferedText:'BufferedText',ReadinessCheck:'ReadinessCheck'};
        if(key==='form-fields')return load(key);
        if(key==='use-dialog-focus')return {useDialogFocus:()=>({current:null})};
        if(key==='g1-fields')return {G1TradeFields:'G1TradeFields',PsychologyFields:'PsychologyFields'};
        if(['vnext-fields','trade-calculation-fields','multi-asset-fields'].includes(key))return load(key);
        throw new Error(name);
      },
      async fetch(url,options){
        if(options.method==='PUT'){const trade=JSON.parse(options.body);writes.push(trade);return {ok:true,json:async()=>({trade:{...trade,revision:trade.revision+1}})};}
        return {ok:true,json:async()=>({trade:structuredClone(initial),images:[],history:[]})};
      },
    });
    modules.set(file,module.exports);return module.exports;
  }
  const Dialog=load('trade-workspace').TradeDialog;
  function expand(node){
    if(Array.isArray(node))return node.map(expand);
    if(!node||typeof node!=='object')return node;
    if(typeof node.type==='function'&&node.type.name!=='ScreenshotGallery')return expand(node.type(node.props));
    return {...node,props:{...node.props,children:expand(node.props.children)}};
  }
  function nodes(node){if(arguments.length===0)node=tree;if(Array.isArray(node))return node.flatMap(child=>nodes(child));if(!node||typeof node!=='object')return [];return [node,...nodes(node.props?.children)];}
  function text(node){if(arguments.length===0)node=tree;if(Array.isArray(node))return node.map(child=>text(child)).join('');if(typeof node==='string'||typeof node==='number')return String(node);return node&&typeof node==='object'?text(node.props?.children):'';}
  function render(){cursor=0;tree=expand(Dialog({initial,settings:testSettings,initialAction,onClose(){closed++;},onSaved:trade=>saved.push(trade),onOpenDay(){},onImagesChanged(){}}));while(effects.length)effects.shift()();return tree;}
  function find(type,predicate=()=>true,node=tree){return nodes(node).find(item=>item.type===type&&predicate(item.props,item));}
  function button(label,node=tree){const element=find('button',(_props,item)=>text(item)===label,node);assert.ok(element,'Missing button '+label);return element.props;}
  function click(label){button(label).onClick();render();}
  function pick(group,label){const container=nodes().filter(node=>node.type==='div'&&node.props.role==='group'&&node.props['aria-label']===group).at(-1);assert.ok(container,'Missing group '+group);button(label,container).onClick();render();}
  function input(label){const field=nodes().filter(item=>item.type==='label'&&nodes(item).some(child=>child.type==='span'&&text(child)===label)).at(-1);assert.ok(field,'Missing input '+label);return find('input',()=>true,field).props;}
  function fill(label,value){input(label).onChange({target:{value:String(value)}});render();}
  function select(label,value){const field=nodes().filter(item=>item.type==='label'&&nodes(item).some(child=>child.type==='span'&&text(child)===label)).at(-1);assert.ok(field,'Missing select '+label);find('select',()=>true,field).props.onChange({target:{value}});render();}
  function draft(label,value){const field=find('BufferedText',props=>props.label===label);assert.ok(field,'Missing text '+label);field.props.onDraft(value);render();}
  async function save(label){if(label)button(label).onClick();await find('form').props.onSubmit({preventDefault(){}});render();}
  return {render,nodes,text,find,button,click,pick,fill,select,draft,save,writes,saved,get current(){return slots[0].value;},get closed(){return closed;},async ready(){await settle();render();await settle();render();}};
}

const unifiedSettings={...settings,multiAsset:{accounts:[{id:'nq-account',name:'NQ账户',currency:'USD',capital:20000},{id:'btc-account',name:'BTC账户',currency:'USDT',capital:10000}],instruments:{
  NQ:{symbol:'NQ实际合约',accountId:'nq-account',quoteSource:'NQ真实报价',contract:{...contract},normalRisk:3000,riskLimit:5000},
  BTC:{symbol:'BTC实际合约',accountId:'btc-account',quoteSource:'BTC真实报价',contract:{...contract,currency:'USDT',feeMode:'notional',entryFeeRate:.001,exitFeeRate:.001},normalRisk:3000,riskLimit:5000},
}}};

function openCommon(h,instrument,framework='G1'){
  h.select('交易品种 · 必选',instrument);h.pick('交易方向','做空');h.pick('策略框架 · 与模型独立',framework==='G1'?'G1顺势交易':'非G1独立结构交易');h.pick('入场模型','S2 支撑跌破回测');
  h.fill('实际入场价格',100);h.fill(`数量 · ${instrument}合约单位`,4);h.fill('执行硬止损价格',105);h.fill('计划目标价格',90);
}

test('all three instruments expose the same original classification, evidence, lifecycle, psychology and G1 controls',async()=>{
  for(const instrument of ['XAU','NQ','BTC'])for(const framework of ['G1','independent']){
    const h=harness(undefined,undefined,unifiedSettings);h.render();openCommon(h,instrument,framework);
    for(const label of ['S1 供给区受阻','S2 支撑跌破回测','L1 需求区支撑','L2 阻力突破回测','提前入场：LH/HL形成'])assert.ok(h.button(label));
    for(const group of ['4H结构','1H结构','15m结构','市场环境 Regime','Trigger确认状态','情绪','执行纪律 · 不按盈亏自动评价'])assert.ok(h.find('div',props=>props.role==='group'&&props['aria-label']===group),group);
    assert.ok(h.button('使用1:1:2 / 已配置比例'));assert.ok(h.button('增加一笔计划分仓'));assert.ok(h.find('section',props=>props['aria-label']==='交易费用'));assert.ok(h.find('section',props=>props['aria-label']==='自动交易计划预览'));
    assert.equal(!!h.find('G1TradeFields'),framework==='G1');h.pick('4H结构','明确空头 LH/LL');h.pick('入场方式','提前入场：LH/HL形成');h.pick('Trigger确认状态','尚未确认，提前入场');h.pick('执行纪律 · 不按盈亏自动评价','完全按计划');
    await h.save('保存并填写详细复盘');assert.equal(h.writes.length,1,h.text());const trade=h.writes[0];
    assert.equal(trade.instrument,instrument);assert.equal(trade.framework,framework);assert.equal(trade.model,'S2');assert.equal(trade.entrySnapshot.structure4H,'bear');assert.equal(trade.entrySnapshot.entryApproach,'early_lh_hl');assert.equal(trade.psychology.discipline,'full');
    assert.ok(h.nodes().find(node=>node.type?.name==='ScreenshotGallery'));assert.ok(h.find('details',props=>props.className==='history-panel'));
  }
});

test('confirming or switching a new opportunity template preserves strategy evidence and only changes contract identity',()=>{
  const g1Plan={...g1Schema.blankG1(settings.g1),side:'long',resistanceLow:90,resistanceHigh:95,exitPlan:'原机会退出计划',checks:{...g1Schema.blankG1(settings.g1).checks,stopDefined:true}};
  const snapshot={...vnextSchema.blankEntrySnapshot(),structure4H:'bull',structure1H:'bear',confirmation:'early',notes:'原始高低周期证据'};
  const initial={...trading.blankTrade('2026-10-20'),sourceOpportunityId:'opportunity-original',framework:'G1',strategy:'G1-L',model:'L2',direction:'long',initialRisk:77,g1:g1Plan,entrySnapshot:snapshot,rationale:'事前入场理由',researchModel:'旧研究模型',executionMode:'旧执行方式'};
  const h=harness(initial,undefined,unifiedSettings);h.render();h.select('交易品种 · 必选','XAU');
  assert.deepEqual(structuredClone(h.current.g1),g1Plan);assert.deepEqual(h.current.entrySnapshot,snapshot);assert.equal(h.current.initialRisk,77);assert.equal(h.current.framework,'G1');assert.equal(h.current.model,'L2');
  h.select('交易品种 · 必选','NQ');assert.equal(h.current.instrument,'NQ');assert.equal(h.current.symbol,'NQ实际合约');assert.equal(h.current.accountId,'nq-account');
  assert.equal(h.current.framework,'G1');assert.equal(h.current.strategy,'G1-L');assert.equal(h.current.model,'L2');assert.equal(h.current.g1.exitPlan,g1Plan.exitPlan);assert.deepEqual(structuredClone(h.current.g1.checks),g1Plan.checks);assert.deepEqual(h.current.entrySnapshot,snapshot);assert.equal(h.current.rationale,'事前入场理由');assert.equal(h.current.researchModel,'旧研究模型');assert.equal(h.current.executionMode,'旧执行方式');
});

test('visible fee controls support manual overrides, proportional partial closes and a single explicit net equation',async()=>{
  const h=harness(undefined,undefined,unifiedSettings);h.render();openCommon(h,'NQ');h.fill('开仓手续费 · 手动覆盖（留空使用估算）',6);await h.save('保存并填写详细复盘');
  assert.equal(h.writes[0].entries[0].fees,6);assert.equal(h.writes[0].entries[0].feeSource,'actual');const risk=h.current.initialRisk;
  h.click('平仓50%');h.fill('平仓价格',90);assert.equal(h.current.closes[0].netPnl,15);h.fill('第1次平仓手续费 · 手动覆盖',5);h.fill('其他已记录成本 · 成交价已含滑点勿重复扣',3);
  assert.equal(h.current.closes[0].netPnl,9);assert.equal(h.current.closes[0].feeSource,'actual');
  const fees=h.find('section',props=>props['aria-label']==='交易费用');assert.match(h.text(fees),/开仓手续费6\.00 USD/);assert.match(h.text(fees),/平仓手续费5\.00 USD/);assert.match(h.text(fees),/当前手续费合计11\.00 USD/);
  const equation=h.find('p',props=>props['aria-label']==='本次净盈亏计算');assert.match(h.text(equation),/毛盈亏 20\.00 − 开仓费分摊 3\.00 − 平仓费 5\.00 − 其他已记录成本 3\.00 = 净盈亏 9\.00 USD/);
  await h.save('保存这笔交易');h.click('全部平仓');h.fill('平仓价格',90);await h.save('保存这笔交易');
  const trade=h.writes.at(-1),summary=calculations.calculateTradePnl(trade,unifiedSettings);assert.equal(summary.grossPnl,40);assert.equal(summary.totalEntryFees,6);assert.equal(summary.totalExitFees,7);assert.equal(summary.totalCosts,16);assert.equal(summary.netPnl,24);assert.equal(trade.initialRisk,risk);
});

test('a missing batch fee stays unknown in fee totals and automatic net, rather than becoming zero',async()=>{
  const h=harness(undefined,undefined,unifiedSettings);h.render();openCommon(h,'BTC');await h.save('保存并填写详细复盘');h.click('全部平仓');h.fill('平仓价格',90);
  h.fill('第1次开仓手续费 · 手动覆盖','');assert.equal(h.current.entries[0].fees,null);assert.equal(h.current.closes[0].netPnl,null);
  const fees=h.find('section',props=>props['aria-label']==='交易费用');assert.match(h.text(fees),/开仓手续费未录 USDT/);assert.match(h.text(fees),/当前手续费合计.*未录 USDT/);await h.save('保存这笔交易');assert.equal(h.writes.length,1);
});

test('a saved execution cannot have its original identity changed by the instrument selection callback',async()=>{
  const initial={...trading.blankTrade('2026-10-13'),instrument:'XAU',revision:1,direction:'short',entryPrice:100,quantity:4,contract,accountId:'legacy',aggregateEntryFee:4,initialRisk:24};
  const h=harness(initial,undefined,unifiedSettings);h.render();await h.ready();const select=h.find('select',props=>props['aria-label']==='交易品种');assert.equal(select.props.disabled,true);select.props.onChange({target:{value:'NQ'}});h.render();assert.equal(h.current.instrument,'XAU');assert.equal(h.current.accountId,'legacy');assert.deepEqual(h.current.contract,contract);
});

