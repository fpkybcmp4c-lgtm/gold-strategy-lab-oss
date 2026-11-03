import { loadOpportunities } from '../../../lib/opportunities';
import { dailyDraftSchema, DEFAULT_SETTINGS } from '../../../lib/domain';
import type { Settings } from '../../../lib/domain';
import { deleteRecord, loadData, loadDrafts } from '../../../lib/repository';
import { allHistory, allTrades, imagesFor, RecordError, saveDailyPreservingTrades, saveTrade } from '../../../lib/trade-repository';
import { apiError, privateContext, privateJSON } from '../private-api';
import { derivedDaily } from '../../../lib/vnext-stats';
import { accountOf, assetTradeCurrency, instrumentOf, multiAssetSummary } from '../../../lib/multi-asset';
export const dynamic='force-dynamic';
export async function GET(request:Request){try{
  const {user,db}=await privateContext(),[data,drafts]=await Promise.all([loadData(db,user.userId),loadDrafts(db,user.userId)]);
  const [trades,images,opportunities]=await Promise.all([allTrades(db,user.userId,data.records),imagesFor(db,user.userId),loadOpportunities(db,user.userId)]);
  if(request&&new URL(request.url).searchParams.get('export')==='1'){
    const backups=await db.prepare('SELECT source_key, data, created_at FROM source_backups WHERE owner_id = ?').bind(user.userId).all();
    return privateJSON({...data,drafts,trades,images,opportunities,history:await allHistory(db,user.userId),sourceBackups:backups.results??[]});
  }
  const dates=[...new Set([...data.records.map(record=>record.date),...trades.flatMap(trade=>[trade.openedDate,...(trade.entries??[]).map(entry=>entry.date),...trade.closes.map(close=>close.date)]).filter((date):date is string=>!!date)])].sort();
  const settings:Settings=data.settings??DEFAULT_SETTINGS,gold=trades.filter(trade=>instrumentOf(trade)==='XAU'&&accountOf(trade)==='legacy'),tradeById=new Map(trades.map(trade=>[trade.id,trade]));
  const allDaily=dates.map(date=>derivedDaily(trades,date,settings));
  const dailySummaries=dates.map((date,index)=>({...derivedDaily(gold,date,settings),statisticsScope:{instrument:'XAU',accountId:'legacy',currency:settings.accountCurrency??'USD'},executionDiscipline:allDaily[index].executionDiscipline,executionDisciplineScope:'owner-global-all-instruments-and-accounts'}));
  const multiAssetDailySummaries=dates.map((date,index)=>{
    const {selected,closed,...summary}=multiAssetSummary(trades,settings,{instrument:'all',start:date,end:date});
    const holdings=allDaily[index].currentPositions.holdings.map(position=>{const trade=tradeById.get(position.tradeId)!;return {...position,instrument:instrumentOf(trade),accountId:accountOf(trade),currency:assetTradeCurrency(trade,settings),symbol:trade.symbol};});
    return {...summary,date,selectedTradeIds:selected.map(trade=>trade.id),completedTradeIds:closed.map(trade=>trade.id),currentPositions:{parentTradeCount:holdings.length,remainingQuantity:null,holdings,quantityAggregation:'not-combined-across-contracts-or-accounts'},executionDiscipline:allDaily[index].executionDiscipline,executionDisciplineScope:'owner-global-all-instruments-and-accounts',source:'saved-formal-parent-trades-and-realized-close-events',statisticsScope:{instrument:'all',accountId:'all'},moneyAggregation:'confirmed-date-specific-fx-only',drawdownAggregation:'separate-account-and-settlement-currency-curves'};
  });
  return privateJSON({...data,drafts,trades,images,opportunities,dailySummaries,multiAssetDailySummaries});
}catch(e){return apiError(e);}}
export async function PUT(request:Request){try{
  const {user,db}=await privateContext(request),result=dailyDraftSchema.safeParse(await request.json());if(!result.success)throw new RecordError(result.error.issues[0].message);
  const stored=await loadData(db,user.userId),settings=stored.settings??DEFAULT_SETTINGS;
  if(result.data.riskCompliant&&result.data.trades.some(t=>t.initialRisk!==null&&t.initialRisk>settings.riskLimit))throw new RecordError('初始风险超过单笔上限，请标记“风险不合规”。');
  const record=await saveDailyPreservingTrades(db,user.userId,result.data);return privateJSON({ok:true,record});
}catch(e){return apiError(e);}}
export async function DELETE(request:Request){try{
  const {user,db}=await privateContext(request),date=new URL(request.url).searchParams.get('date');if(!date||!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new RecordError('日期无效');
  const data=await loadData(db,user.userId),old=data.records.find(d=>d.date===date);
  if(old){
    for(const t of (await allTrades(db,user.userId,[old])).filter(t=>t.legacy?.dailyDate===date&&t.revision===0))await saveTrade(db,user.userId,t,[old]);
    const now=new Date().toISOString();await db.batch([
      db.prepare('INSERT OR IGNORE INTO source_backups (owner_id, source_key, data, created_at) VALUES (?, ?, ?, ?)').bind(user.userId,'daily:'+date,JSON.stringify(old),now),
      db.prepare('INSERT INTO record_history (owner_id, id, entity_type, entity_id, data, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(user.userId,crypto.randomUUID(),'daily',date,JSON.stringify([{field:'删除每日观察',before:old,after:null}]),now),
    ]);
  }
  await deleteRecord(db,user.userId,date);return privateJSON({ok:true});
}catch(e){return apiError(e);}}
