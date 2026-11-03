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
        if(key==='form-fields')return {Num:'FieldNum'};
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

function completeOpen(h,framework='G1'){
  h.select('交易品种 · 必选','XAU');
  h.pick('交易方向','做空');h.pick('策略框架 · 与模型独立',framework==='G1'?'G1顺势交易':'非G1独立结构交易');h.pick('入场模型',framework==='G1'?'S1 供给区受阻':'S2 支撑跌破回测');
  h.fill('实际入场价格',100);h.fill('数量 · XAU合约单位',2);h.fill('执行硬止损价格',110);h.fill('计划目标价格',80);
}

test('quick G1-S + S1 and independent + S2 save distinct frameworks with a real entry and tagged estimated fees',async()=>{
  for(const framework of ['G1','independent']){
    const h=harness();h.render();completeOpen(h,framework);await h.save('保存并返回');
    assert.equal(h.writes.length,1);const trade=h.writes[0];
    assert.equal(trade.framework,framework);assert.equal(trade.strategy,framework==='G1'?'G1-S':'none');assert.equal(trade.model,framework==='G1'?'S1':'S2');
    assert.equal(trade.entries.length,1);assert.equal(trade.entries[0].quantity,2);assert.equal(trade.entries[0].fees,2);assert.equal(trade.entries[0].feeSource,'estimated');
    assert.equal(trade.initialRisk,24);assert.equal(h.closed,1);
  }
});

test('three timeframes and early confirmation are independent snapshots; selected psychology preserves missing ratings as null',async()=>{
  const h=harness();h.render();completeOpen(h,'independent');
  h.pick('4H结构','明确多头 HH/HL');h.pick('1H结构','明确空头 LH/LL');h.pick('15m结构','明确空头 LH/LL');h.pick('入场方式','提前入场：LH/HL形成');h.pick('Trigger确认状态','尚未确认，提前入场');
  h.pick('情绪','平静');h.select('精力 · 1—10','8');h.select('精力 · 1—10','');h.pick('外部意见依赖','查看但未影响计划');await h.save('保存并返回');
  const trade=h.writes[0];assert.equal(trade.entrySnapshot.structure4H,'bull');assert.equal(trade.entrySnapshot.structure1H,'bear');assert.equal(trade.entrySnapshot.structure15m,'bear');assert.equal(trade.entrySnapshot.entryApproach,'early_lh_hl');assert.equal(trade.entrySnapshot.confirmation,'early');
  assert.deepEqual(trade.psychology.emotions,['calm']);assert.equal(trade.psychology.energy,null);assert.equal(trade.psychology.fomo,null);assert.equal(trade.psychology.fear,null);assert.equal(trade.psychology.externalOpinion,'viewed_unaffected');assert.equal(trade.psychology.kolChangedPlan,false);
  const confirmed=harness();confirmed.render();completeOpen(confirmed);confirmed.pick('入场方式','突破后回测确认');confirmed.pick('Trigger确认状态','已确认');await confirmed.save('保存并返回');
  assert.equal(confirmed.writes[0].entrySnapshot.entryApproach,'breakout_retest');assert.equal(confirmed.writes[0].entrySnapshot.confirmation,'confirmed');
});

test('save and continue creates a separate blank hypothesis without inheriting market facts or psychology',async()=>{
  const h=harness();h.render();completeOpen(h);h.pick('4H结构','明确空头 LH/LL');h.pick('情绪','平静');const firstId=h.current.id;
  await h.save('保存并继续记录');assert.equal(h.saved[0].id,firstId);assert.notEqual(h.current.id,firstId);assert.equal(h.current.revision,0);assert.equal(h.current.entrySnapshot.structure4H,null);assert.equal(h.current.entrySnapshot.confirmation,null);assert.equal(h.current.framework,'pending');assert.equal(h.current.psychology,undefined);assert.equal(h.current.entryPrice,null);assert.equal(h.closed,0);
  completeOpen(h,'independent');await h.save('保存并填写详细复盘');assert.equal(h.writes.length,2);assert.notEqual(h.writes[1].id,firstId);assert.equal(h.closed,0);assert.equal(h.find('details',(_props,node)=>h.text(node.props.children[0])==='高级信息、成交时间与历史更正').props.open,true);
});

test('quick closes use current remaining position, store multiple reasons and keep the original 1R and prior net result',async()=>{
  const initial=trading.syncStatus({...trading.blankTrade('2026-10-11'),framework:'G1',strategy:'G1-S',revision:1,direction:'short',openedTime:'09:00:00',entryPrice:100,quantity:8,originalStop:110,currentStop:110,targetPrice:80,initialRisk:100,contract,aggregateEntryFee:8,closes:[{id:'old',date:'2026-10-11',time:'10:00:00',quantity:2,price:90,fees:2,netPnl:16,reason:'历史实值'}]});
  const h=harness(initial);h.render();await h.ready();h.click('平仓25%');assert.equal(h.current.closes.at(-1).quantity,1.5);h.fill('平仓价格',90);
  h.pick('平仓原因','交易时间结束');h.pick('平仓原因','关键支撑未破');h.select('主要平仓原因 · 从已选原因中确认','time_end');
  assert.equal(h.current.closes.at(-1).netPnl,12);assert.equal(h.current.initialRisk,100);assert.equal(h.current.closes[0].netPnl,16);assert.match(h.text(),/本次净R0\.12/);assert.match(h.text(),/父交易累计净R0\.28/);
  await h.save('保存这笔交易');const close=h.writes[0].closes.at(-1);assert.deepEqual(close.reasons,['time_end','support_holds']);assert.equal(close.primaryReason,'time_end');assert.equal(h.writes[0].initialRisk,100);
  h.click('平仓50%');assert.equal(h.current.closes.at(-1).quantity,2.25);assert.equal(h.current.closes[0].reason,'历史实值');assert.equal(h.current.closes[1].netPnl,12);
});

test('normal-risk warning requires a reason; hard-limit plans are blocked while actual fills remain recordable and flagged',async()=>{
  const h=harness();h.render();completeOpen(h,'independent');h.fill('数量 · XAU合约单位',12);assert.match(h.text(),/风险超过常规预算/);await h.save('保存并返回');assert.equal(h.writes.length,0);assert.match(h.text(),/请确认并填写超过常规风险预算的原因/);
  h.draft('超常规预算原因 / 真实风险违规说明','已事前确认风险144，分仓总量12。');await h.save('保存并返回');assert.equal(h.writes.length,1);assert.equal(h.writes[0].overNormalReason,'已事前确认风险144，分仓总量12。');
  const hard=harness();hard.render();completeOpen(hard,'independent');hard.fill('数量 · XAU合约单位',20);hard.select('计划还是实际成交？','plan');await hard.save('保存并返回');assert.equal(hard.writes.length,0);assert.match(hard.text(),/计划风险超过硬上限/);
  hard.select('计划还是实际成交？','executed');await hard.save('保存并返回');assert.equal(hard.writes.length,1);assert.equal(hard.writes[0].riskCompliant,false);assert.equal(hard.writes[0].entries[0].quantity,20);
});

test('all four close shortcuts use six remaining XAU, and quick add preserves the parent and earlier realized amount',async()=>{
  const initial=trading.syncStatus({...trading.blankTrade('2026-10-11'),framework:'G1',strategy:'G1-S',revision:1,direction:'short',openedTime:'09:00:00',entryPrice:100,quantity:8,originalStop:110,currentStop:110,targetPrice:80,initialRisk:100,contract,aggregateEntryFee:8,closes:[{id:'old',date:'2026-10-11',time:'10:00:00',quantity:2,price:90,fees:2,netPnl:16,reason:'保留实值'}]});
  for(const [label,expected] of [['平仓25%',1.5],['平仓50%',3],['平仓75%',4.5],['全部平仓',6]]){
    const h=harness(initial);h.render();await h.ready();h.click(label);assert.equal(h.current.closes.at(-1).quantity,expected);assert.equal(h.current.initialRisk,100);assert.equal(h.current.closes[0].netPnl,16);
  }
  const add=harness(initial);add.render();await add.ready();add.click('增加分仓');add.fill('成交数量',2);add.fill('成交价格',105);await add.save('保存这笔交易');
  assert.equal(add.writes.length,1);const trade=add.writes[0];assert.equal(trade.id,initial.id);assert.equal(trade.entries.length,2);assert.equal(trade.entries[0].price,100);assert.equal(trade.entries[0].fees,8);assert.equal(trade.entries[1].quantity,2);assert.equal(trade.entries[1].fees,2);assert.equal(trade.entries[1].feeSource,'estimated');assert.equal(trade.quantity,10);assert.equal(trade.initialRisk,100);assert.equal(trade.closes[0].netPnl,16);
});

test('recording a real close fee above its estimate does not require a new entry-risk exception reason',async()=>{
  const riskRuleSnapshot={capturedAt:'2026-10-11T01:00:00Z',source:'entry',framework:'independent',version:'test-entry-rule',effectiveAt:null,normalMin:80,normalMax:120,hardLimit:200,approvedInitialRisk:108,contract,accountCurrency:'USD',priceRisk:90,fees:18,slippage:0,totalRisk:108,overNormalReason:'',trialDays:14,noLossAddsDuringTrial:false};
  const initial={...trading.blankTrade('2026-10-11'),framework:'independent',strategy:'none',revision:1,direction:'short',openedTime:'09:00:00',entryPrice:100,quantity:9,originalStop:110,currentStop:110,targetPrice:80,initialRisk:108,contract,aggregateEntryFee:9,riskRuleSnapshot};
  const h=harness(initial);h.render();await h.ready();h.click('全部平仓');h.fill('平仓价格',95);h.fill('该次平仓费用（可空）',33);
  assert.equal(vnext.vnextRiskAssessment(h.current,settings).overNormal,true);
  await h.save('保存这笔交易');assert.equal(h.writes.length,1);assert.equal(h.writes[0].closes[0].fees,33);assert.equal(h.writes[0].closes[0].feeSource,'actual');assert.equal(h.writes[0].closes[0].netPnl,3);assert.equal(h.writes[0].initialRisk,108);assert.equal(h.writes[0].overNormalReason??'','');
});

test('close and closeAll entry actions reuse one draft when ratios change, calculate from the pre-draft remainder and reserve explicit add for another event',async()=>{
  const initial=trading.syncStatus({...trading.blankTrade('2026-10-11'),framework:'G1',strategy:'G1-S',revision:1,direction:'short',openedTime:'09:00:00',entryPrice:100,quantity:8,originalStop:110,currentStop:110,targetPrice:80,initialRisk:100,contract,aggregateEntryFee:8,closes:[{id:'old',date:'2026-10-11',time:'10:00:00',quantity:2,price:90,fees:2,netPnl:16,reason:'历史实值'}]});
  for(const initialAction of ['close','closeAll']){
    const h=harness(initial,initialAction);h.render();await h.ready();assert.equal(h.current.closes.length,2);const id=h.current.closes[1].id;
    assert.equal(h.current.closes[1].quantity,initialAction==='close'?null:6);
    h.click('平仓25%');assert.equal(h.current.closes.length,2);assert.equal(h.current.closes[1].id,id);assert.equal(h.current.closes[1].quantity,1.5);
    h.fill('平仓价格',90);h.pick('平仓原因','交易时间结束');h.select('主要平仓原因 · 从已选原因中确认','time_end');
    h.click('平仓50%');assert.equal(h.current.closes.length,2);assert.equal(h.current.closes[1].id,id);assert.equal(h.current.closes[1].quantity,3);assert.equal(h.current.closes[1].fees,3);assert.equal(h.current.closes[1].price,90);assert.equal(h.current.closes[1].netPnl,24);assert.equal(h.current.closes[1].primaryReason,'time_end');
    h.click('自定义数量');assert.equal(h.current.closes.length,2);assert.equal(h.current.closes[1].id,id);assert.equal(h.current.closes[1].quantity,null);h.fill('平仓数量',2);
    h.click('增加一次');assert.equal(h.current.closes.length,3);assert.equal(h.current.closes[1].quantity,2);assert.notEqual(h.current.closes[2].id,id);
    h.click('平仓25%');assert.equal(h.current.closes.length,3);assert.equal(h.current.closes[2].quantity,1);h.fill('平仓价格',90);
    await h.save('保存这笔交易');assert.equal(h.writes.length,1);assert.equal(h.writes[0].closes.length,3);assert.equal(h.writes[0].initialRisk,100);assert.equal(h.writes[0].closes[0].netPnl,16);
  }
});

test('history supplement records explicit confirmation and user-provided evidence; frozen snapshots disable controls',async()=>{
  const initial={...trading.blankTrade('2026-10-12'),framework:undefined,entrySnapshot:undefined,revision:1,openedTime:'10:00:00',direction:'short',entryPrice:100,quantity:2,originalStop:110,currentStop:110,initialRisk:24,targetPrice:80,contract,aggregateEntryFee:2};
  const h=harness(initial);h.render();await h.ready();h.click('编辑交易');h.pick('策略框架 · 与模型独立','非G1独立结构交易');h.pick('4H结构','明确多头 HH/HL');h.pick('本次确认补录的字段','策略框架');h.pick('本次确认补录的字段','开仓市场快照');h.draft('说明原始依据 · 补录时必填','开仓前截图和当时记录已核对。');
  const supplementLabel=h.nodes().find(node=>node.type==='label'&&h.text(node).includes('我确认以上补录反映开仓时事实'));const checkbox=h.find('input',props=>props.type==='checkbox',supplementLabel);checkbox.props.onChange({target:{checked:true}});h.render();await h.save('保存这笔交易');
  assert.equal(h.writes[0].historicalSupplement.confirmed,true);assert.equal(h.writes[0].historicalSupplement.sourceNote,'开仓前截图和当时记录已核对。');assert.deepEqual(h.writes[0].historicalSupplement.fields,['framework','entrySnapshot']);
  const frozen=harness({...initial,entrySnapshot:{...vnextSchema.blankEntrySnapshot(),capturedAt:'2026-10-12T02:00:00Z',source:'entry',structure4H:'bull'}});frozen.render();await frozen.ready();assert.ok(frozen.find('fieldset',props=>props.disabled===true&&frozen.nodes({props}).some(node=>node.props?.['aria-label']==='4H结构')));assert.match(frozen.text(),/已保存的开仓快照保持不变/);
});

test('every new hypothesis requires an explicit instrument choice, including save and continue',async()=>{
  const h=harness();h.render();await h.save('保存并返回');
  assert.equal(h.writes.length,0);assert.match(h.text(),/请先明确选择本笔交易品种/);
  completeOpen(h);await h.save('保存并继续记录');assert.equal(h.writes.length,1);
  await h.save('保存并返回');assert.equal(h.writes.length,1);assert.match(h.text(),/请先明确选择本笔交易品种/);
});

const multiSettings={...settings,multiAsset:{accounts:[{id:'nq-account',name:'纳指账户',currency:'USD',capital:20000},{id:'btc-account',name:'BTC账户',currency:'USDT',capital:10000}],instruments:{
  NQ:{symbol:'MNQ actual',accountId:'nq-account',quoteSource:'broker NQ',contract:{...contract,usdPerPriceUnit:20,entryFeePerQty:3,exitFeePerQty:4},models:['NQ回测模型'],environments:['NQ趋势'],executionModes:['NQ确认'],normalRisk:3000,riskLimit:5000},
  BTC:{symbol:'BTCUSDT actual',accountId:'btc-account',quoteSource:'broker BTC',contract:{...contract,currency:'USDT',feeMode:'notional',entryFeeRate:.01,exitFeeRate:.01},models:['BTC突破模型'],environments:['BTC区间'],executionModes:['BTC回测'],normalRisk:3000,riskLimit:5000},
}}};

test('NQ and BTC reuse the full strategy form with their own contract settings, fixed versus notional fees, edits and closes',async()=>{
  for(const instrument of ['NQ','BTC']){
    const h=harness(undefined,undefined,multiSettings);h.render();h.select('交易品种 · 必选',instrument);
    const config=multiSettings.multiAsset.instruments[instrument];
    assert.equal(h.current.symbol,config.symbol);assert.equal(h.current.accountId,config.accountId);assert.equal(h.current.quoteSource,config.quoteSource);
    assert.ok(h.find('div',props=>props.role==='group'&&props['aria-label']==='策略框架 · 与模型独立'));
    assert.match(h.text(),/使用1:1:2/);assert.equal(h.current.g1,undefined);assert.equal(h.current.model,'S1');
    h.pick('交易方向','做多');h.pick('策略框架 · 与模型独立','非G1独立结构交易');h.pick('入场模型','L2 阻力突破回测');h.draft('自定义研究模型 · 兼容补充标签',config.models[0]);h.draft('大级别市场环境',config.environments[0]);h.draft('执行方式 · 兼容补充标签',config.executionModes[0]);
    h.fill('实际入场价格',100);h.fill(`数量 · ${instrument}合约单位`,2);h.fill('执行硬止损价格',95);h.fill('计划目标价格',110);
    await h.save('保存并填写详细复盘');assert.equal(h.writes.length,1);const opened=h.writes[0],id=opened.id;
    assert.equal(opened.instrument,instrument);assert.equal(opened.model,'L2');assert.equal(opened.framework,'independent');assert.equal(opened.researchModel,config.models[0]);assert.equal(opened.environment,config.environments[0]);assert.equal(opened.executionMode,config.executionModes[0]);
    assert.equal(opened.entries[0].fees,instrument==='NQ'?6:2);assert.equal(opened.initialRisk,instrument==='NQ'?214:13.9);assert.equal(opened.riskRuleSnapshot,undefined);
    h.draft('为什么选择这笔交易',`${instrument}原始入场依据。`);await h.save('保存这笔交易');assert.equal(h.writes.length,2);assert.equal(h.writes[1].id,id);assert.equal(h.writes[1].rationale,`${instrument}原始入场依据。`);
    const identity=h.nodes().find(node=>node.type==='select'&&node.props['aria-label']==='交易品种');assert.equal(identity.props.disabled,true);
    h.click('全部平仓');h.fill('平仓价格',110);assert.equal(h.current.closes[0].fees,instrument==='NQ'?8:2.2);assert.equal(h.current.closes[0].netPnl,instrument==='NQ'?386:15.8);
    await h.save('保存这笔交易');const closed=h.writes.at(-1);assert.equal(closed.id,id);assert.equal(closed.status,'closed');assert.equal(closed.initialRisk,opened.initialRisk);assert.equal(closed.entries[0].fees,opened.entries[0].fees);
  }
});

test('inverse contracts default to broker net settlement without manufacturing an automatic result',async()=>{
  const inverseSettings={...multiSettings,multiAsset:{...multiSettings.multiAsset,instruments:{...multiSettings.multiAsset.instruments,BTC:{...multiSettings.multiAsset.instruments.BTC,contract:{...multiSettings.multiAsset.instruments.BTC.contract,settlement:'inverse',currency:'BTC'}}}}};
  const h=harness(undefined,undefined,inverseSettings);h.render();h.select('交易品种 · 必选','BTC');h.pick('交易方向','做多');h.fill('实际入场价格',100);h.fill('数量 · BTC合约单位',2);h.fill('执行硬止损价格',95);h.fill('计划目标价格',110);
  await h.save('保存并填写详细复盘');assert.equal(h.writes.length,1);assert.equal(h.writes[0].initialRisk,null);
  h.click('全部平仓');assert.equal(h.current.closes[0].calculationMode,'reported');assert.equal(h.current.closes[0].netPnl,null);
  assert.equal(h.find('option',props=>props.value==='automatic').props.disabled,true);
  h.fill('该次扣费后净损益',.0007);await h.save('保存这笔交易');assert.equal(h.writes.at(-1).closes[0].netPnl,.0007);assert.equal(h.writes.at(-1).contract.currency,'BTC');
});

test('independent instruments can acknowledge their own normal-risk threshold without adopting gold budgets',async()=>{
  const ownBudget={...multiSettings,multiAsset:{...multiSettings.multiAsset,instruments:{...multiSettings.multiAsset.instruments,NQ:{...multiSettings.multiAsset.instruments.NQ,normalRisk:200,riskLimit:500}}}};
  const h=harness(undefined,undefined,ownBudget);h.render();h.select('交易品种 · 必选','NQ');h.pick('交易方向','做多');h.fill('实际入场价格',100);h.fill('数量 · NQ合约单位',2);h.fill('执行硬止损价格',95);h.fill('计划目标价格',110);
  assert.match(h.text(),/风险超过常规预算 200 USD/);await h.save('保存并返回');assert.equal(h.writes.length,0);
  h.draft('超常规预算原因 / 真实风险违规说明','本笔NQ总风险214，已核对独立预算。');await h.save('保存并返回');assert.equal(h.writes.length,1);assert.equal(h.writes[0].overNormalReason,'本笔NQ总风险214，已核对独立预算。');
});

test('an unknown independent risk limit does not turn a user-supplied initial risk into a violation',()=>{
  const unknownBudget={...multiSettings,multiAsset:{...multiSettings.multiAsset,instruments:{...multiSettings.multiAsset.instruments,NQ:{...multiSettings.multiAsset.instruments.NQ,normalRisk:null,riskLimit:null}}}};
  const h=harness(undefined,undefined,unknownBudget);h.render();h.select('交易品种 · 必选','NQ');h.fill('固定初始1R风险 · 历史更正需明确依据',214);
  assert.equal(h.current.initialRisk,214);assert.equal(h.current.riskCompliant,null);assert.equal(vnext.vnextRiskAssessment(h.current,unknownBudget).overHard,null);
});

test('confirming XAU on an existing G1 opportunity template preserves its original model and plan',()=>{
  const plan={...g1Schema.blankG1(settings.g1),side:'long',resistanceLow:90,resistanceHigh:95,exitPlan:'原机会退出计划'};
  const initial={...trading.blankTrade('2026-10-20'),framework:'G1',strategy:'G1-L',model:'L1',direction:'long',g1:plan};
  const h=harness(initial);h.render();h.select('交易品种 · 必选','XAU');
  assert.equal(h.current.framework,'G1');assert.equal(h.current.strategy,'G1-L');assert.equal(h.current.model,'L1');
  assert.deepEqual(structuredClone(h.current.g1),plan);assert.equal(h.current.direction,'long');
});
