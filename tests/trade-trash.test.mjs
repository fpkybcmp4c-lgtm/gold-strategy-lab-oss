import test from 'node:test';
import assert from 'node:assert/strict';
import { apiHarness } from './api-harness.mjs';
import { allTrades, putImageMetadata, saveTrade } from '../lib/trade-repository.ts';
import { blankTrade, legacyId, syncStatus, totalRealized } from '../lib/trading.ts';
import { DEMO_SETTINGS as DEFAULT_SETTINGS } from './demo-settings.mjs';
import { blankDay } from '../lib/domain.ts';
import { multiAssetSummary } from '../lib/multi-asset.ts';
import { buildReviewData } from '../lib/review-data.ts';

const contract={confirmed:true,currency:'USD',usdPerPriceUnit:1,entryFeePerQty:1,exitFeePerQty:1,slippagePrice:0,quantityStep:1};
function fixture(instrument){return syncStatus({...blankTrade('2026-10-20'),instrument,symbol:instrument+'-TRASH-TEST',accountId:'legacy',framework:'G1',strategy:'G1-S',model:'S2',direction:'short',openedTime:'09:15:00',entryPrice:100,quantity:4,originalStop:105,currentStop:105,targetPrice:90,initialRisk:24,contract,rationale:'原始入场依据',summary:'原始复盘',psychology:{fomo:5,discipline:'partial',deviationReasons:['unplanned_entry']},entries:[{id:instrument+'-entry',date:'2026-10-20',time:'09:15:00',quantity:4,price:100,fees:4,feeSource:'actual',rationale:'分批依据',inPlan:true,lossAdd:false}],closes:[{id:instrument+'-close',date:'2026-10-20',time:'10:00:00',quantity:2,price:90,fees:2,feeSource:'actual',netPnl:16,calculationMode:'reported',reason:'原始真实平仓'}]});}
const comparable=trade=>{const copy=JSON.parse(JSON.stringify(trade));for(const key of ['archived','revision','trashedAt','restoredAt'])delete copy[key];return copy;};
const scope={start:'2026-10-01',end:'2026-10-31',instrument:'all'};
const patch=async(h,trade,action)=>{const response=await h.trades.PATCH(h.req('/api/trades','PATCH',{id:trade.id,revision:trade.revision,action}));return {status:response.status,...await response.json()};};

test('XAU, NQ and BTC soft delete and restore preserve every trading fact, screenshot blob and audit across reload and login',async()=>{
  const h=apiHarness();try{
    const saved=[];
    for(const instrument of ['XAU','NQ','BTC']){
      const trade=await saveTrade(h.db,'A',fixture(instrument),[]);saved.push(trade);
      const key='private/'+trade.id+'/original.png',at='2026-10-20T02:00:00.000Z';
      await h.bucket.put(key,new Uint8Array([137,80,78,71,1,2,3,4]));
      await putImageMetadata(h.db,'A',{id:instrument+'-image',tradeId:trade.id,fileName:'original.png',mime:'image/png',size:8,timeframe:'1小时',stage:'开仓前分析',caption:'原始截图',createdAt:at,updatedAt:at},key);
    }
    assert.equal(multiAssetSummary(saved,DEFAULT_SETTINGS,scope).tradeCount,3);
    const objectKeys=[...h.objects.keys()],imagesBefore=h.sql.prepare('SELECT * FROM trade_images ORDER BY id').all();
    for(const original of saved){
      const originalJSON=h.sql.prepare('SELECT data FROM trade_records WHERE owner_id = ? AND id = ?').get('A',original.id).data;
      let result=await patch(h,original,'trash');assert.equal(result.status,200,result.error);let trade=result.trade;
      assert.equal(trade.archived,true);assert.equal(trade.revision,original.revision+1);assert.deepEqual(comparable(trade),comparable(original));
      assert.equal(h.sql.prepare('SELECT data FROM source_backups WHERE owner_id = ? AND source_key = ?').get('A','trade:'+trade.id+':revision:'+original.revision).data,originalJSON);
      h.setUser(null);assert.equal((await h.trades.GET(h.req('/api/trades?id='+trade.id))).status,401);h.setUser({userId:'A'});
      const reload=await (await h.trades.GET(h.req('/api/trades?id='+trade.id))).json();assert.equal(reload.trade.archived,true);assert.equal(reload.images.length,1);assert.equal(reload.history.length,3);assert.deepEqual(comparable(reload.trade),comparable(original));
      const after=await allTrades(h.db,'A',[]),summary=multiAssetSummary(after,DEFAULT_SETTINGS,scope);assert.equal(summary.tradeCount,2);assert.equal(summary.netPnl,32);
      const plugin=buildReviewData({records:[],trades:after,images:[],settings:DEFAULT_SETTINGS},{scope:'range',start:scope.start,end:scope.end});assert.equal(plugin.trades.some(item=>item.id===trade.id),false);
      assert.deepEqual(h.sql.prepare('SELECT * FROM trade_images ORDER BY id').all(),imagesBefore);assert.deepEqual([...h.objects.keys()],objectKeys);
      result=await patch(h,trade,'restore');assert.equal(result.status,200,result.error);trade=result.trade;assert.equal(trade.archived,false);assert.equal(trade.revision,original.revision+2);assert.deepEqual(comparable(trade),comparable(original));
      const restored=await (await h.trades.GET(h.req('/api/trades?id='+trade.id))).json();assert.equal(restored.history.length,4);assert.equal(restored.images.length,1);assert.equal(totalRealized(restored.trade),16);assert.equal(restored.trade.initialRisk,24);
      const operations=restored.history.flatMap(entry=>entry.changes).filter(change=>change.field==='回收站操作').map(change=>change.after);assert.deepEqual(new Set(operations),new Set(['移入回收站','恢复交易']));
      const restoredSummary=multiAssetSummary(await allTrades(h.db,'A',[]),DEFAULT_SETTINGS,scope);assert.equal(restoredSummary.tradeCount,3);assert.equal(restoredSummary.netPnl,48);
    }
    assert.equal(h.sql.prepare('SELECT COUNT(*) n FROM trade_records').get().n,3);assert.equal(h.sql.prepare('SELECT COUNT(*) n FROM trade_images').get().n,3);assert.equal(h.objects.size,3);
  }finally{h.sql.close();}
});

test('trash mutations require owner, same origin, a current revision and an exact narrow action body',async()=>{
  const h=apiHarness();try{
    const original=await saveTrade(h.db,'A',fixture('NQ'),[]),count=()=>h.sql.prepare('SELECT COUNT(*) n FROM record_history').get().n;
    h.setUser(null);assert.equal((await h.trades.PATCH(h.req('/api/trades','PATCH',{id:original.id,revision:original.revision,action:'trash'}))).status,401);
    h.setUser({userId:'B'});assert.equal((await patch(h,original,'trash')).status,404);h.setUser({userId:'A'});
    assert.equal((await h.trades.PATCH(h.req('/api/trades','PATCH',{id:original.id,revision:original.revision,action:'trash'},'https://other.test'))).status,403);
    for(const body of [{id:original.id,revision:original.revision,action:'delete-forever'},{id:original.id,revision:original.revision,action:'trash',closes:[]},{id:original.id,revision:-1,action:'trash'}])assert.equal((await h.trades.PATCH(h.req('/api/trades','PATCH',body))).status,400);
    assert.equal(count(),1);const removed=await patch(h,original,'trash');assert.equal(removed.status,200);
    assert.equal((await patch(h,original,'restore')).status,409);assert.equal(count(),2);
    const repeat=await patch(h,removed.trade,'trash');assert.equal(repeat.status,200);assert.equal(repeat.trade.revision,removed.trade.revision);assert.equal(count(),2);
    const reloaded=await (await h.trades.GET(h.req('/api/trades?id='+original.id))).json();assert.equal(reloaded.trade.archived,true);assert.deepEqual(reloaded.trade.closes,original.closes);
  }finally{h.sql.close();}
});

test('deleting a legacy daily trade creates a reversible override without rewriting or duplicating the original daily record',async()=>{
  const h=apiHarness();try{
    const day={...blankDay('2026-10-10'),trades:[{id:'original-old',model:'S1',netPnl:19.5,initialRisk:10,inPlan:true}]},raw=JSON.stringify(day);
    h.sql.prepare('INSERT INTO daily_records (owner_id, date, data, updated_at) VALUES (?, ?, ?, ?)').run('A',day.date,raw,'2026-10-10T12:00:00.000Z');
    const id=legacyId(day.date,'original-old'),original=(await allTrades(h.db,'A',[day]))[0];assert.equal(original.id,id);assert.equal(original.revision,0);
    const removed=await patch(h,original,'trash');assert.equal(removed.status,200,removed.error);assert.equal(removed.trade.id,id);assert.deepEqual(comparable(removed.trade),comparable(original));
    let combined=await allTrades(h.db,'A',[day]);assert.equal(combined.length,1);assert.equal(combined[0].archived,true);assert.equal(multiAssetSummary(combined,DEFAULT_SETTINGS,scope).tradeCount,0);
    const plugin=buildReviewData({records:[day],trades:combined,images:[],settings:DEFAULT_SETTINGS},{scope:'range',start:scope.start,end:scope.end});assert.equal(plugin.trades.length,0);
    assert.equal(h.sql.prepare('SELECT data FROM daily_records WHERE owner_id = ? AND date = ?').get('A',day.date).data,raw);assert.equal(h.sql.prepare('SELECT data FROM source_backups WHERE owner_id = ? AND source_key = ?').get('A','daily:'+day.date).data,raw);
    const restored=await patch(h,removed.trade,'restore');assert.equal(restored.status,200);combined=await allTrades(h.db,'A',[day]);assert.equal(combined.length,1);assert.equal(combined[0].archived,false);assert.equal(totalRealized(combined[0]),19.5);assert.equal(combined[0].initialRisk,10);assert.deepEqual(comparable(restored.trade),comparable(original));
  }finally{h.sql.close();}
});

test('an incomplete historical automatic close can be trashed and restored without changing null costs or recalculating its old result',async()=>{
  const h=apiHarness();try{
    const original={...fixture('BTC'),revision:7,contract:{...contract,confirmed:false,usdPerPriceUnit:null},closes:[{id:'old-incomplete',date:'2026-10-20',time:'10:00:00',quantity:2,price:90,fees:null,netPnl:12.3456,calculationMode:'automatic',reason:'历史原值'}]};
    h.sql.prepare('INSERT INTO trade_records (owner_id,id,data,revision,change_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('A',original.id,JSON.stringify(original),7,'old-write','2026-10-20T01:00:00Z','2026-10-20T01:00:00Z');
    const removed=await patch(h,original,'trash');assert.equal(removed.status,200,removed.error);assert.deepEqual(comparable(removed.trade),comparable(original));assert.equal(removed.trade.closes[0].fees,null);assert.equal(removed.trade.closes[0].netPnl,12.3456);
    const restored=await patch(h,removed.trade,'restore');assert.equal(restored.status,200);assert.deepEqual(comparable(restored.trade),comparable(original));
  }finally{h.sql.close();}
});
