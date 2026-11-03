import { refreshAutomaticCloses } from '../../../lib/calculations';
import { riskSnapshot } from '../../../lib/g1';
import { DEFAULT_SETTINGS } from '../../../lib/domain';
import type { Settings } from '../../../lib/domain';
import { loadData } from '../../../lib/repository';
import { hasExecution, lifecycleSchema, tradeCurrency, instrumentOf } from '../../../lib/trading';
import { allTrades, historyFor, imagesFor, RecordError, saveTrade, setTradeTrashState } from '../../../lib/trade-repository';
import { apiError, privateContext, privateJSON } from '../private-api';
import { captureRiskRuleSnapshot, vnextRiskAssessment } from '../../../lib/vnext';
import {accountOf,instrumentConfig} from '../../../lib/multi-asset';
import {captureAssetRules} from '../../../lib/asset-policy';
export const dynamic='force-dynamic';
export async function GET(request:Request){try{const {user,db}=await privateContext();const data=await loadData(db,user.userId),trades=await allTrades(db,user.userId,data.records),id=new URL(request.url).searchParams.get('id');if(!id)return privateJSON({trades,images:await imagesFor(db,user.userId)});const trade=trades.find(t=>t.id===id);if(!trade)throw new RecordError('交易不存在或不属于当前账号。',404);const [images,history]=await Promise.all([imagesFor(db,user.userId,id),historyFor(db,user.userId,'trade',id)]);return privateJSON({trade,images,history});}catch(e){return apiError(e);}}
export async function PUT(request:Request){try{
  const {user,db}=await privateContext(request),parsed=lifecycleSchema.safeParse(await request.json());
  if(!parsed.success)throw new RecordError(parsed.error.issues[0].message);
  const {records,settings}=await loadData(db,user.userId),config:Settings=settings??DEFAULT_SETTINGS;
  const row=await db.prepare('SELECT data, revision FROM trade_records WHERE owner_id = ? AND id = ?').bind(user.userId,parsed.data.id).first<{data:string;revision:number}>();
  const before=row?JSON.parse(row.data):null;
  let candidate=parsed.data;
  if(!before&&!candidate.legacy&&!candidate.instrument)throw new RecordError('新交易必须明确选择交易品种。');
  if(before&&hasExecution(before)&&(instrumentOf(before)!==instrumentOf(candidate)||accountOf(before)!==accountOf(candidate)))throw new RecordError('已成交记录的品种与账户归属不能通过普通编辑覆盖。');
  if(before&&hasExecution(before)&&JSON.stringify(before.contract)!==JSON.stringify(candidate.contract))throw new RecordError('已成交合约规则快照不能覆盖；费用在逐次成交中更正。');
  if(instrumentOf(candidate)!=='XAU'){
    if(!candidate.accountId?.trim()||!candidate.symbol?.trim())throw new RecordError('请填写本品种的真实账户与合约代码。');
    if(!before||!hasExecution(before))candidate={...candidate,contract:candidate.contract??structuredClone(instrumentConfig(config,instrumentOf(candidate)).contract)};
    if(!before||!hasExecution(before))candidate={...candidate,instrumentRiskSnapshot:hasExecution(candidate)?captureAssetRules(candidate,config):undefined};
    else if(JSON.stringify(candidate.instrumentRiskSnapshot)!==JSON.stringify(before.instrumentRiskSnapshot))throw new RecordError('入场时的独立品种风险规则不能覆盖。');
  }
  if(before?.entrySnapshot?.capturedAt&&before.entrySnapshot.framework&&before.entrySnapshot.framework!=='pending'&&candidate.framework!==before.framework)throw new RecordError('入场策略框架已冻结；原始分类不能通过普通编辑覆盖。');
  // Capture authoritative rules on first save. A client cannot enlarge its own allowance.
  const firstExecution=(!before||!hasExecution(before))&&hasExecution(candidate)&&!candidate.legacy;
  if(firstExecution){
    const riskRuleSnapshot=captureRiskRuleSnapshot({...candidate,riskRuleSnapshot:undefined},config);
    candidate={...candidate,riskRuleSnapshot};
  }else if(!before&&!candidate.legacy)candidate={...candidate,riskRuleSnapshot:undefined};
  if(before?.riskRuleSnapshot&&JSON.stringify(candidate.riskRuleSnapshot)!==JSON.stringify(before.riskRuleSnapshot))throw new RecordError('入场风险规则快照不能覆盖。');
  const policy=vnextRiskAssessment(firstExecution?{...candidate,revision:0}:candidate,config);
  const applies=!!candidate.riskRuleSnapshot||instrumentOf(candidate)!=='XAU'&&!!candidate.instrumentRiskSnapshot||candidate.recordType==='plan'&&policy.framework!=='pending'||firstExecution&&policy.ruleAppliesToEntry===true;
  if(applies){
    const overHard=policy.overHard===true||!policy.currencyMismatch&&policy.hardLimit!==null&&candidate.initialRisk!==null&&candidate.initialRisk>policy.hardLimit+1e-8;
    const riskOperation=firstExecution||candidate.recordType==='plan'||!!before&&((candidate.entries??[]).some(entry=>!(before.entries??[]).some((saved:{id:string})=>saved.id===entry.id))||candidate.currentStop!==before.currentStop||candidate.originalStop!==before.originalStop);
    if(policy.requiresReason&&!overHard&&riskOperation)throw new RecordError('超过常规风险预算，请填写确认原因后保存。');
    if((overHard||policy.trial.violatingEntryIds.length)&&candidate.recordType==='plan')throw new RecordError('计划超过硬风险上限或试行期禁止亏损加仓；实际成交请切换为真实成交登记。');
    if(overHard||policy.trial.violatingEntryIds.length)candidate={...candidate,riskCompliant:false};
    else if(firstExecution&&candidate.riskCompliant!==false)candidate={...candidate,riskCompliant:policy.riskCompliant};
    else if(riskOperation&&policy.riskCompliant===null&&candidate.riskCompliant===true)candidate={...candidate,riskCompliant:null};
    if(firstExecution&&candidate.initialRisk===null&&policy.totalRisk!==null)candidate={...candidate,initialRisk:policy.totalRisk,plannedRiskAtEntry:policy.totalRisk};
  }else{
    // Legacy records keep the previously saved account rule; B rules are never applied retroactively.
    const exceeds=instrumentOf(candidate)==='XAU'&&(tradeCurrency(candidate)===(config.accountCurrency??'USD')&&candidate.initialRisk!==null&&candidate.initialRisk>config.riskLimit||riskSnapshot(candidate,config).overHard);
    if(candidate.riskCompliant===true&&exceeds)throw new RecordError('风险超过已保存的硬上限，请标记风险不合规；实际违规记录仍可保存。');
  }
  const recalculated=refreshAutomaticCloses(candidate,config),valid=lifecycleSchema.safeParse(recalculated);
  if(!valid.success)throw new RecordError('自动结算所需的价格、数量、合约或真实开仓费用不完整，请补全或使用券商净额。');
  const trade=await saveTrade(db,user.userId,valid.data,records);return privateJSON({ok:true,trade});
}catch(e){return apiError(e);}}

export async function PATCH(request:Request){try{
  const {user,db}=await privateContext(request),input=await request.json() as {id?:unknown;revision?:unknown;action?:unknown};
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['id','revision','action'].includes(key))||typeof input.id!=='string'||!input.id||input.id.length>500||typeof input.revision!=='number'||!Number.isInteger(input.revision)||input.revision<0||!['trash','restore'].includes(String(input.action)))throw new RecordError('请提供交易ID、当前版本和有效的回收站操作。');
  const {records}=await loadData(db,user.userId),trade=await setTradeTrashState(db,user.userId,input.id,input.revision,input.action==='trash',records);
  return privateJSON({ok:true,trade});
}catch(e){return apiError(e);}}
