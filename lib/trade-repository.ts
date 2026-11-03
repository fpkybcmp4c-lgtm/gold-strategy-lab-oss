import { dailySchema } from './domain.ts';
import type { DailyRecord } from './domain.ts';
import { compatibleTrades, fieldChanges, hasExecution, legacyId } from './trading.ts';
import type { HistoryEntry, TradeImage, TradeRecord } from './trading.ts';

export class RecordError extends Error{status:number;constructor(message:string,status=400){super(message);this.status=status;}}
type StoredTrade={data:string;revision:number};
export async function storedTrades(db:D1Database,owner:string){const rows=await db.prepare('SELECT data, revision FROM trade_records WHERE owner_id = ? ORDER BY updated_at DESC').bind(owner).all<StoredTrade>();return (rows.results??[]).map(row=>({...JSON.parse(row.data),revision:row.revision}) as TradeRecord);}
export async function allTrades(db:D1Database,owner:string,days:DailyRecord[]){return compatibleTrades(days,await storedTrades(db,owner));}
export async function historyFor(db:D1Database,owner:string,entityType:string,entityId:string){const rows=await db.prepare('SELECT id, data, created_at FROM record_history WHERE owner_id = ? AND entity_type = ? AND entity_id = ? ORDER BY created_at DESC').bind(owner,entityType,entityId).all<{id:string;data:string;created_at:string}>();return (rows.results??[]).map(row=>({id:row.id,entityType,entityId,createdAt:row.created_at,changes:JSON.parse(row.data)}) as HistoryEntry);}
export async function allHistory(db:D1Database,owner:string){const rows=await db.prepare('SELECT id, entity_type, entity_id, data, created_at FROM record_history WHERE owner_id = ? ORDER BY created_at DESC').bind(owner).all<{id:string;entity_type:HistoryEntry['entityType'];entity_id:string;data:string;created_at:string}>();return (rows.results??[]).map(row=>({id:row.id,entityType:row.entity_type,entityId:row.entity_id,createdAt:row.created_at,changes:JSON.parse(row.data)}));}
function backup(db:D1Database,owner:string,key:string,data:string,now:string){return db.prepare('INSERT OR IGNORE INTO source_backups (owner_id, source_key, data, created_at) VALUES (?, ?, ?, ?)').bind(owner,key,data,now);}

function hasSnapshotFacts(snapshot:TradeRecord['entrySnapshot']){
  if(!snapshot)return false;
  return [snapshot.structure4H,snapshot.structure1H,snapshot.structure15m,snapshot.regime,snapshot.volatility,snapshot.entryApproach,snapshot.keyPrice,snapshot.setupStage,snapshot.confirmation,snapshot.invalidationType,snapshot.invalidationPrice].some(value=>value!==null)||snapshot.locations.length>0||snapshot.triggerTypes.length>0||snapshot.notes.trim().length>0;
}
function frameworkOf(t:TradeRecord){return t.framework??(t.strategy==='none'?'independent':t.strategy==='G1-L'||t.strategy==='G1-S'?'G1':'pending');}

/** A confirmed supplement can fill a missing block; already captured facts remain immutable. */
function entryMetadata(before:TradeRecord|null,input:TradeRecord,now:string){
  const wasExecuted=before!==null&&hasExecution(before),actual=hasExecution(input),fields:('framework'|'entrySnapshot'|'riskRuleSnapshot')[]=[];
  if(wasExecuted&&before?.entrySnapshot?.capturedAt&&JSON.stringify(before.entrySnapshot)!==JSON.stringify(input.entrySnapshot))throw new RecordError('开仓结构快照不能覆盖；后续行情请保存为新的观察状态。');
  if(wasExecuted&&before?.riskRuleSnapshot&&JSON.stringify(before.riskRuleSnapshot)!==JSON.stringify(input.riskRuleSnapshot))throw new RecordError('入场风险规则快照不能覆盖；保留原始批准风险与规则。');
  if(wasExecuted&&frameworkOf(before!)==='pending'&&frameworkOf(input)!=='pending')fields.push('framework');
  if(wasExecuted&&!before?.entrySnapshot&&hasSnapshotFacts(input.entrySnapshot))fields.push('entrySnapshot');
  if(wasExecuted&&!before?.riskRuleSnapshot&&input.riskRuleSnapshot)fields.push('riskRuleSnapshot');
  const confirmation=input.historicalSupplement;
  if(fields.length&&(!confirmation?.confirmed||!confirmation.sourceNote.trim()||fields.some(field=>!confirmation.fields.includes(field))))throw new RecordError('历史缺失信息需先核对事实、填写来源并明确确认补录，不能自动推断。');
  if(fields.includes('riskRuleSnapshot')&&confirmation?.evidence!=='pre-entry-record')throw new RecordError('历史批准风险和规则仅能依据原始事前记录确认补录；无法核实时保留未知。');
  let entrySnapshot=input.entrySnapshot,riskRuleSnapshot=input.riskRuleSnapshot;
  if(!actual){if(entrySnapshot)entrySnapshot={...entrySnapshot,capturedAt:null,source:null};}
  else if(wasExecuted&&!before?.entrySnapshot&&!fields.includes('entrySnapshot'))entrySnapshot=undefined;
  else if(entrySnapshot&&!before?.entrySnapshot?.capturedAt){entrySnapshot={...entrySnapshot,capturedAt:now,source:fields.includes('entrySnapshot')?'user-confirmed-history':'entry',framework:input.framework??null,model:input.model,direction:input.direction};}
  if(fields.includes('riskRuleSnapshot')&&riskRuleSnapshot)riskRuleSnapshot={...riskRuleSnapshot,capturedAt:now,source:'user-confirmed-history'};
  const historicalSupplement=fields.length&&confirmation?{...confirmation,confirmedAt:now}:before?.historicalSupplement??confirmation;
  return {entrySnapshot,riskRuleSnapshot,historicalSupplement};
}

export async function saveTrade(db:D1Database,owner:string,input:TradeRecord,days:DailyRecord[]):Promise<TradeRecord>{
  const row=await db.prepare('SELECT data, revision FROM trade_records WHERE owner_id = ? AND id = ?').bind(owner,input.id).first<StoredTrade>();
  let before:TradeRecord|null=row?{...JSON.parse(row.data),revision:row.revision}:null;
  if(!input.legacy&&input.id.startsWith('legacy:'))throw new RecordError('旧交易ID必须保留其原始来源。');
  const now=new Date().toISOString(),changeId=crypto.randomUUID(),statements:D1PreparedStatement[]=[];
  if(!row&&input.legacy){
    const original=days.find(d=>d.date===input.legacy!.dailyDate),old=original?.trades.find(t=>t.id===input.legacy!.tradeId);
    if(!original||!old||input.id!==legacyId(original.date,old.id))throw new RecordError('找不到对应的旧交易，请重新读取记录。',409);
    before=compatibleTrades([original],[]).find(t=>t.id===input.id)??null;
    const raw=await db.prepare('SELECT data FROM daily_records WHERE owner_id = ? AND date = ?').bind(owner,original.date).first<{data:string}>();
    if(raw)statements.push(backup(db,owner,'daily:'+original.date,raw.data,now));
  }
  if(row&&input.revision!==row.revision||!row&&input.revision!==0)throw new RecordError('这笔交易已被更新，请重新打开后再保存，避免覆盖新内容。',409);
  if(before&&JSON.stringify(before.legacy?.dailyDate)!==JSON.stringify(input.legacy?.dailyDate)||before&&JSON.stringify(before.legacy?.tradeId)!==JSON.stringify(input.legacy?.tradeId))throw new RecordError('旧交易来源不能更改。');
  if(before?.originalPlan&&JSON.stringify(before.originalPlan)!==JSON.stringify(input.originalPlan))throw new RecordError('原始计划快照不能覆盖；更正请在当前计划中填写，修改历史会保留差异。');
  const metadata=entryMetadata(before,input,now);
  const baselinePlan=before??input;
  const originalPlan=before?.originalPlan??{capturedAt:now,data:{openedDate:baselinePlan.openedDate,openedTime:baselinePlan.openedTime,direction:baselinePlan.direction,model:baselinePlan.model,inPlan:baselinePlan.inPlan,entryPrice:baselinePlan.entryPrice,quantity:baselinePlan.quantity,originalStop:baselinePlan.originalStop,initialRisk:baselinePlan.initialRisk,invalidation:baselinePlan.invalidation,rationale:baselinePlan.rationale,strategy:baselinePlan.strategy??null,framework:baselinePlan.framework??null,entrySnapshot:before?baselinePlan.entrySnapshot??null:metadata.entrySnapshot??null,riskRuleSnapshot:before?baselinePlan.riskRuleSnapshot??null:metadata.riskRuleSnapshot??null,contract:baselinePlan.contract??null,entryPlan:baselinePlan.entryPlan??null,plannedRiskAtEntry:baselinePlan.plannedRiskAtEntry??null,g1:baselinePlan.g1??null}};
  const next={...input,...metadata,originalPlan,revision:(row?.revision??0)+1};
  const writeIndex=statements.length;
  if(row)statements.push(db.prepare('UPDATE trade_records SET data = ?, revision = ?, change_id = ?, updated_at = ? WHERE owner_id = ? AND id = ? AND revision = ? RETURNING revision').bind(JSON.stringify(next),next.revision,changeId,now,owner,next.id,input.revision));
  else statements.push(db.prepare('INSERT INTO trade_records (owner_id, id, data, revision, change_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner_id,id) DO NOTHING RETURNING revision').bind(owner,next.id,JSON.stringify(next),next.revision,changeId,now,now));
  // Back up the exact prior JSON only when this optimistic write won. A conflict
  // must not leave an apparent successful revision backup or audit entry.
  if(row)statements.push(db.prepare('INSERT OR IGNORE INTO source_backups (owner_id, source_key, data, created_at) SELECT ?, ?, ?, ? FROM trade_records WHERE owner_id = ? AND id = ? AND change_id = ?').bind(owner,'trade:'+next.id+':revision:'+row.revision,row.data,now,owner,next.id,changeId));
  statements.push(db.prepare('INSERT INTO record_history (owner_id, id, entity_type, entity_id, data, created_at) SELECT ?, ?, ?, ?, ?, ? FROM trade_records WHERE owner_id = ? AND id = ? AND change_id = ?').bind(owner,changeId,'trade',next.id,JSON.stringify(fieldChanges(before,next)),now,owner,next.id,changeId));
  const results=await db.batch(statements);
  if(!results[writeIndex].results?.length)throw new RecordError('这笔交易已被更新，请重新读取。',409);
  return next;
}

/** Change only visibility. Trading facts and incomplete historical costs are never recalculated. */
export async function setTradeTrashState(db:D1Database,owner:string,id:string,revision:number,archived:boolean,days:DailyRecord[]):Promise<TradeRecord>{
  const row=await db.prepare('SELECT data, revision FROM trade_records WHERE owner_id = ? AND id = ?').bind(owner,id).first<StoredTrade>();
  const before:TradeRecord|null=row?{...JSON.parse(row.data),revision:row.revision}:compatibleTrades(days,[]).find(t=>t.id===id)??null;
  if(!before)throw new RecordError('交易不存在或不属于当前账号。',404);
  if(revision!==before.revision)throw new RecordError('这笔交易已被更新，请重新读取后再操作，避免覆盖新内容。',409);
  if(before.archived===archived)return before;
  const now=new Date().toISOString(),changeId=crypto.randomUUID();
  const next:TradeRecord={...before,archived,revision:before.revision+1,...(archived?{trashedAt:now}:{restoredAt:now})};
  const statements:D1PreparedStatement[]=[];
  if(row)statements.push(db.prepare('UPDATE trade_records SET data = ?, revision = ?, change_id = ?, updated_at = ? WHERE owner_id = ? AND id = ? AND revision = ? RETURNING revision').bind(JSON.stringify(next),next.revision,changeId,now,owner,id,revision));
  else statements.push(db.prepare('INSERT INTO trade_records (owner_id, id, data, revision, change_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner_id,id) DO NOTHING RETURNING revision').bind(owner,id,JSON.stringify(next),next.revision,changeId,now,now));
  if(row)statements.push(db.prepare('INSERT OR IGNORE INTO source_backups (owner_id, source_key, data, created_at) SELECT ?, ?, ?, ? FROM trade_records WHERE owner_id = ? AND id = ? AND change_id = ?').bind(owner,'trade:'+id+':revision:'+row.revision,row.data,now,owner,id,changeId));
  else if(before.legacy){
    const source=await db.prepare('SELECT data FROM daily_records WHERE owner_id = ? AND date = ?').bind(owner,before.legacy.dailyDate).first<{data:string}>();
    if(source)statements.push(db.prepare('INSERT OR IGNORE INTO source_backups (owner_id, source_key, data, created_at) SELECT ?, ?, ?, ? FROM trade_records WHERE owner_id = ? AND id = ? AND change_id = ?').bind(owner,'daily:'+before.legacy.dailyDate,source.data,now,owner,id,changeId));
  }
  const changes=[{field:'回收站操作',before:before.archived?'已在回收站':'正常交易',after:archived?'移入回收站':'恢复交易'},...fieldChanges(before,next)];
  statements.push(db.prepare('INSERT INTO record_history (owner_id, id, entity_type, entity_id, data, created_at) SELECT ?, ?, ?, ?, ?, ? FROM trade_records WHERE owner_id = ? AND id = ? AND change_id = ?').bind(owner,changeId,'trade',id,JSON.stringify(changes),now,owner,id,changeId));
  const results=await db.batch(statements);
  if(!results[0].results?.length)throw new RecordError('这笔交易已被更新，请重新读取后再操作。',409);
  return next;
}

export async function saveDailyPreservingTrades(db:D1Database,owner:string,incoming:DailyRecord){
  const row=await db.prepare('SELECT data FROM daily_records WHERE owner_id = ? AND date = ?').bind(owner,incoming.date).first<{data:string}>();
  const old:DailyRecord|null=row?JSON.parse(row.data):null;
  const merged={...old,...incoming,trades:old?.trades??[],...(old?.wellbeing&&incoming.wellbeing?{wellbeing:{...old.wellbeing,...incoming.wellbeing}}:{})};
  const parsed=dailySchema.safeParse(merged);if(!parsed.success)throw new RecordError(parsed.error.issues[0].message);
  const now=new Date().toISOString(),id=crypto.randomUUID(),statements:D1PreparedStatement[]=[];
  if(row)statements.push(backup(db,owner,'daily:'+incoming.date,row.data,now));
  statements.push(db.prepare('INSERT INTO daily_records (owner_id, date, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(owner_id,date) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at').bind(owner,incoming.date,JSON.stringify(parsed.data),now));
  statements.push(db.prepare('INSERT INTO record_history (owner_id, id, entity_type, entity_id, data, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(owner,id,'daily',incoming.date,JSON.stringify(fieldChanges(old,parsed.data)),now));
  statements.push(db.prepare('DELETE FROM daily_drafts WHERE owner_id = ? AND date = ?').bind(owner,incoming.date));
  await db.batch(statements);return parsed.data as DailyRecord;
}

export async function imagesFor(db:D1Database,owner:string,tradeId?:string):Promise<TradeImage[]>{const rows=await db.prepare('SELECT data FROM trade_images WHERE owner_id = ?'+(tradeId?' AND trade_id = ?':'')+' ORDER BY created_at').bind(...(tradeId?[owner,tradeId]:[owner])).all<{data:string}>();return (rows.results??[]).map(row=>JSON.parse(row.data));}
export async function imageRow(db:D1Database,owner:string,id:string){return db.prepare('SELECT object_key, data FROM trade_images WHERE owner_id = ? AND id = ?').bind(owner,id).first<{object_key:string;data:string}>();}
export async function putImageMetadata(db:D1Database,owner:string,image:TradeImage,objectKey:string,before?:TradeImage){const changeId=crypto.randomUUID(),now=new Date().toISOString();await db.batch([
  db.prepare('INSERT INTO trade_images (owner_id, id, trade_id, object_key, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner_id,id) DO UPDATE SET object_key = excluded.object_key, data = excluded.data, updated_at = excluded.updated_at').bind(owner,image.id,image.tradeId,objectKey,JSON.stringify(image),image.createdAt,image.updatedAt),
  db.prepare('INSERT INTO record_history (owner_id, id, entity_type, entity_id, data, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(owner,changeId,image.entityType==='daily'?'daily':image.entityType==='opportunity'?'opportunity':'trade',image.dailyDate??image.opportunityId??image.tradeId,JSON.stringify([{field:'截图:'+image.id,before:before??null,after:image}]),now),
]);}
export async function deleteImageMetadata(db:D1Database,owner:string,image:TradeImage){const now=new Date().toISOString();await db.batch([
  db.prepare('DELETE FROM trade_images WHERE owner_id = ? AND id = ?').bind(owner,image.id),
  db.prepare('INSERT INTO record_history (owner_id, id, entity_type, entity_id, data, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(owner,crypto.randomUUID(),image.entityType==='daily'?'daily':image.entityType==='opportunity'?'opportunity':'trade',image.dailyDate??image.opportunityId??image.tradeId,JSON.stringify([{field:'截图:'+image.id,before:image,after:null}]),now),
]);}
