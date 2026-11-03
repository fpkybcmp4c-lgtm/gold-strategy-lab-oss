import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { apiHarness } from './api-harness.mjs';
import { DEMO_SETTINGS as DEFAULT_SETTINGS } from './demo-settings.mjs';
import { blankDay, equitySeries, summarize, recordR, riskR } from '../lib/domain.ts';
import { blankTrade, compatibleTrades, filterTrades, lifecycleSchema, syncStatus } from '../lib/trading.ts';
import { ledgerDays } from '../lib/ledger.ts';
import { saveRecord, saveSettings } from '../lib/repository.ts';
import { growthSummary, weeklyMarkdown, weeklyReport } from '../lib/wellbeing.ts';

const settings={...DEFAULT_SETTINGS,riskLimit:400};
const close=(date,q,net,id=crypto.randomUUID())=>({id,date,time:'12:00',quantity:q,price:2600,fees:2,netPnl:net,reason:'真实测试平仓'});
const create=(model='S1')=>({...blankTrade('2026-10-10'),openedTime:'10:00',direction:model.startsWith('S')?'short':'long',model,entryPrice:2500,quantity:3,initialRisk:100});
const filters={from:'',to:'',model:'all',direction:'all',plan:'all',status:'all',archived:false};
async function save(h,t){const r=await h.trades.PUT(h.req('/api/trades','PUT',t)),d=await r.json();assert.equal(r.status,200,d.error);return d.trade;}
async function data(h){const r=await h.records.GET();assert.equal(r.status,200);return r.json();}
function png(r,g,b){
  const crc=bytes=>{let c=0xffffffff;for(const v of bytes){c^=v;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;};
  const chunk=(name,bytes)=>{const type=Buffer.from(name),out=Buffer.alloc(bytes.length+12);out.writeUInt32BE(bytes.length);type.copy(out,4);bytes.copy(out,8);out.writeUInt32BE(crc(Buffer.concat([type,bytes])),out.length-4);return out;};
  const header=Buffer.alloc(13);header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,r,g,b]))),chunk('IEND',Buffer.alloc(0))]);
}
function uploadForm(t,name='kline.png',bytes=png(80,120,50)){const f=new FormData();f.set('tradeId',t.id);f.set('file',new File([bytes],name,{type:'image/png'}));f.set('timeframe',t.model==='S1'?'日线':t.model==='S2'?'4小时':'1小时');f.set('stage','开仓前分析');f.set('caption','独立证据 '+t.model);return f;}

test('isolated acceptance: three independent same-day trades, distinct persistent screenshots, edits and filters',async()=>{
  const h=apiHarness(),day={...blankDay('2026-10-10'),violations:2,planCompliant:false,fomo:8,wellbeing:{stress:8,energy:3,sleepHours:4,exercised:false}};
  await saveRecord(h.db,'A',day);await saveSettings(h.db,'A',settings);
  const three=[];for(const model of ['S1','S2','L1'])three.push(await save(h,create(model)));
  assert.equal(new Set(three.map(t=>t.id)).size,3);
  const img=[];for(let i=0;i<3;i++){const r=await h.images.POST(h.req('/api/images','POST',uploadForm(three[i],i+'.png',png(50+i*60,80,20))));assert.equal(r.status,200);img.push((await r.json()).image);}
  assert.equal(new Set(img.map(i=>i.tradeId)).size,3);assert.equal(h.objects.size,3);
  for(const i of img){const r=await h.images.GET(h.req('/api/images?id='+i.id));assert.equal(r.status,200);assert.equal(r.headers.get('Content-Type'),'image/png');assert.match(r.headers.get('Cache-Control'),/private, no-store/);assert.equal((await r.arrayBuffer()).byteLength,i.size);}
  const edited=await save(h,{...three[0],entryPrice:2510,pattern:'单独更正这笔'}),reload=await data(h);
  assert.equal(reload.trades.length,3);assert.deepEqual(reload.trades.find(t=>t.id===three[1].id),three[1]);assert.deepEqual(reload.trades.find(t=>t.id===three[2].id),three[2]);
  assert.equal(reload.images.length,3);assert.equal(reload.trades.find(t=>t.id===edited.id).entryPrice,2510);
  assert.equal(filterTrades(reload.trades,{...filters,model:'S2'}).length,1);assert.equal(filterTrades(reload.trades,{...filters,direction:'long'}).length,1);assert.equal(filterTrades(reload.trades,{...filters,from:'2026-10-11'}).length,0);
  assert.deepEqual(reload.records,[day]);assert.deepEqual(reload.settings,settings);assert(!JSON.stringify(reload.records).includes('base64'));
  const projected=ledgerDays(reload.records,reload.trades),s=summarize(projected,settings);assert.equal(s.newTrades,3);assert.equal(s.trades,0);assert.equal(s.totalPnl,0);assert.equal(s.days,1);assert.equal(s.violations,2);assert.equal(s.fomo,8);assert.equal(s.score,50);
  assert.equal(growthSummary(projected,'2026-10-13',14,settings).stressCount,1);h.sql.close();
});
test('cross-day partial closes realize net only on each close date, count whole R once, retain daily state once',async()=>{
  const h=apiHarness();await saveSettings(h.db,'A',settings);await saveRecord(h.db,'A',{...blankDay('2026-10-10'),fomo:8,wellbeing:{stress:6,energy:4}});
  let t=await save(h,create()),u=await save(h,create('L2'));
  t=await save(h,syncStatus({...t,closes:[close('2026-10-11',1,50)]}));let d=await data(h),days=ledgerDays(d.records,d.trades),s=summarize(days,settings);
  assert.equal(t.status,'partial');assert.equal(s.totalPnl,50);assert.equal(s.trades,0);assert.equal(s.partialEvents,1);assert.equal(s.totalR,null);assert.equal(recordR(days.find(d=>d.date==='2026-10-11')),null);
  t=await save(h,syncStatus({...t,closes:[...t.closes,close('2026-10-12',1,-25),close('2026-10-13',1,80)]}));
  d=await data(h);days=ledgerDays(d.records,d.trades);s=summarize(days,settings);assert.equal(t.status,'closed');assert.equal(s.totalPnl,105);assert.equal(s.totalR,1.05);assert.equal(s.trades,1);assert.equal(s.closeEvents,3);assert.equal(s.partialEvents,2);assert.equal(s.winRate,100);assert.equal(s.newTrades,2);
  assert.equal(s.days,1);assert.equal(s.fomo,8);assert.equal(s.score,100);assert.equal(growthSummary(days,'2026-10-13',14,settings).records.length,1);
  assert.deepEqual(equitySeries(days,settings).map(d=>d.dailyPnl),[0,50,-25,80]);assert.equal(s.maxDrawdown,25);
  const week=weeklyReport(days,settings,'2026-10-11','2026-10-13');assert.equal(week.stats.totalPnl,50);assert.equal(week.stats.partialEvents,1);assert.equal(week.stats.knownR,0);assert.equal(week.wellbeing.energyCount,1);assert.match(weeklyMarkdown(week),/部分平仓事件/);
  const corrected={...t,closes:t.closes.map((c,i)=>i===0?{...c,netPnl:45,price:2610,fees:3}:c)};t=await save(h,corrected);d=await data(h);s=summarize(ledgerDays(d.records,d.trades),settings);assert.equal(s.totalPnl,100);assert.equal(s.totalR,1);assert.equal(d.trades.find(v=>v.id===u.id).closes.length,0);
  const history=await (await h.trades.GET(h.req('/api/trades?id='+t.id))).json();assert(history.history.some(h=>h.changes.some(c=>c.field==='closes'&&c.before?.[0]?.netPnl===50&&c.after?.[0]?.netPnl===45)));h.sql.close();
});
test('historical daily edits retain arrays, unknown fields, health, raw backups and saved settings; lazy legacy promotion is idempotent',async()=>{
  const h=apiHarness(),old={...blankDay('2026-10-10'),customHistorical:'必须保留',trades:[{id:'old-1',model:'S2',netPnl:77,initialRisk:null,inPlan:true}],wellbeing:{stress:7,worry:6,energy:4,trigger:'旧触发',sleepHours:5.5}};
  await saveRecord(h.db,'A',old);await saveSettings(h.db,'A',settings);const original=h.sql.prepare('SELECT data FROM daily_records').get().data;
  let d=await data(h);assert.equal(d.trades[0].openedDate,null);assert.equal(d.trades[0].quantity,null);assert.deepEqual(d.trades[0].closes,[]);assert.equal(h.sql.prepare('SELECT COUNT(*) AS n FROM trade_records').get().n,0);
  const response=await h.records.PUT(h.req('/api/records','PUT',{...old,note:'补录前一天观察',trades:[],wellbeing:{trigger:'更新触发'}}));assert.equal(response.status,200);
  d=await data(h);assert.deepEqual(d.records[0].trades,old.trades);assert.equal(d.records[0].wellbeing.energy,4);assert.equal(d.records[0].customHistorical,'必须保留');assert.deepEqual(d.settings,settings);assert.equal(h.sql.prepare('SELECT COUNT(*) AS n FROM daily_records').get().n,1);
  let t=await save(h,{...d.trades[0],initialRisk:80,legacy:{...d.trades[0].legacy,netPnl:79}});d=await data(h);assert.equal(d.trades.length,1);assert.equal(summarize(ledgerDays(d.records,d.trades),settings).totalPnl,79);
  assert.equal((await h.trades.PUT(h.req('/api/trades','PUT',{...t,revision:0}))).status,409);assert.equal(h.sql.prepare('SELECT COUNT(*) AS n FROM trade_records').get().n,1);
  assert.equal(h.sql.prepare('SELECT data FROM source_backups WHERE source_key = ?').get('daily:2026-10-10').data,original);
  t=await save(h,{...t,archived:true});d=await data(h);assert.equal(summarize(ledgerDays(d.records,d.trades),settings).totalPnl,0);t=await save(h,{...t,archived:false});
  t=await save(h,{...t,legacy:{...t.legacy,detailed:true},closes:[close('2026-10-10',null,22),{...close('2026-10-10',null,55),time:'13:00'}]});
  d=await data(h);const s=summarize(ledgerDays(d.records,d.trades),settings);assert.equal(s.totalPnl,77);assert.equal(s.trades,1);assert.equal(s.closeEvents,2);assert.equal(s.partialEvents,1);assert.equal(s.totalR,77/80);assert.deepEqual(d.records[0].trades,old.trades);
  assert.equal(compatibleTrades(d.records,d.trades).length,1);assert.deepEqual(d.settings,settings);h.sql.close();
});
test('private screenshot APIs enforce owner and origin, survive metadata edits/replacement, reject invalid files and audit deletion',async()=>{
  const h=apiHarness(),t=await save(h,create());let r=await h.images.POST(h.req('/api/images','POST',uploadForm(t))),i=(await r.json()).image;assert.equal(r.status,200);
  h.setUser({userId:'B'});assert.equal((await h.images.GET(h.req('/api/images?id='+i.id))).status,404);assert.equal((await h.images.DELETE(h.req('/api/images?id='+i.id,'DELETE'))).status,404);assert.equal((await h.trades.GET(h.req('/api/trades?id='+t.id))).status,404);
  h.setUser(null);assert.equal((await h.images.GET(h.req('/api/images?id='+i.id))).status,401);
  h.setUser({userId:'A'});assert.equal((await h.images.POST(h.req('/api/images','POST',uploadForm(t),'https://other.test'))).status,403);assert.equal(h.objects.size,1);
  r=await h.images.PATCH(h.req('/api/images?id='+i.id,'PATCH',{timeframe:'15分钟',stage:'平仓结果',caption:'中文复盘，末尾。'}));assert.equal(r.status,200);i=(await r.json()).image;
  const originalKey=h.sql.prepare('SELECT object_key FROM trade_images').get().object_key;
  r=await h.images.PUT(h.req('/api/images?id='+i.id,'PUT',uploadForm(t,'replacement.png',png(180,30,20))));assert.equal(r.status,200);const replaced=(await r.json()).image;assert.equal(replaced.id,i.id);assert.equal(replaced.tradeId,t.id);assert.equal(h.objects.size,1);assert(!h.objects.has(originalKey));
  assert.equal((await h.images.POST(h.req('/api/images','POST',uploadForm(t,'bad.png',Buffer.from('<svg onload="alert(1)"></svg>'))))).status,400);assert.equal(h.objects.size,1);
  r=await h.images.DELETE(h.req('/api/images?id='+i.id,'DELETE'));assert.equal(r.status,200);assert.equal(h.objects.size,0);assert.equal((await data(h)).images.length,0);
  assert((await (await h.trades.GET(h.req('/api/trades?id='+t.id))).json()).history.some(h=>h.changes.some(c=>c.field==='截图:'+i.id&&c.after===null)));h.sql.close();
});
test('validation prevents synthetic closes, over-closing, zero-risk R and stale writes; API uses saved risk ceiling',async()=>{
  const h=apiHarness();await saveSettings(h.db,'A',settings);const t=create();assert.equal(lifecycleSchema.safeParse({...t,status:'closed'}).success,false);
  assert.equal(lifecycleSchema.safeParse({...t,status:'closed',closes:[close('2026-10-11',4,30)]}).success,false);assert.equal(lifecycleSchema.safeParse({...t,closes:[close('2026-10-09',1,30)]}).success,false);
  assert.equal(lifecycleSchema.safeParse({...t,status:'partial',closes:[{...close('2026-10-11',1,30),netPnl:null}]}).success,false);
  assert.equal(riskR({initialRisk:0,netPnl:50}),null);assert.equal(riskR({initialRisk:100,netPnl:50,partial:true}),null);
  assert.equal((await h.trades.PUT(h.req('/api/trades','PUT',{...t,initialRisk:450,riskCompliant:true}))).status,400);let saved=await save(h,t);const old=saved;saved=await save(h,{...saved,executionNote:'新版本'});assert.equal((await h.trades.PUT(h.req('/api/trades','PUT',{...old,executionNote:'过期版本'}))).status,409);assert.equal((await data(h)).trades[0].executionNote,'新版本');
  assert.equal((await h.trades.PUT(h.req('/api/trades','PUT',create('S2'),'https://other.test'))).status,403);h.sql.close();
});

test('phase 1: multiple entries share one hypothesis, preserve CN seconds and realize multiple cross-week closes once',async()=>{
  const h=apiHarness();await saveSettings(h.db,'A',settings);const day={...blankDay('2026-10-10'),wellbeing:{energy:3,stress:7},violations:1,planCompliant:false};await saveRecord(h.db,'A',day);
  const entry=(date,time,q,p)=>({id:crypto.randomUUID(),date,time,quantity:q,price:p,fees:1,rationale:'真实结构确认',inPlan:true,lossAdd:false});
  let t=await save(h,syncStatus({...create(),entries:[entry('2026-10-10','10:00:03',1,2500),entry('2026-10-11','14:20:11',1,2510),entry('2026-10-12','18:05:29',2,2490)]}));
  assert.equal(t.quantity,4);assert.equal(t.entryPrice,2497.5);assert.equal(t.openedTime,'10:00:03');assert.equal(t.openedDate,'2026-10-10');
  t=await save(h,syncStatus({...t,closes:[close('2026-10-11',1,45),close('2026-10-15',1,60),close('2026-10-18',2,-20)]}));
  let d=await data(h),s=summarize(ledgerDays(d.records,d.trades),settings);assert.equal(t.status,'closed');assert.equal(s.newTrades,1);assert.equal(s.trades,1);assert.equal(s.closeEvents,3);assert.equal(s.totalPnl,85);assert.equal(s.totalR,.85);assert.equal(s.days,1);assert.equal(s.violations,1);assert.equal(s.fomo,0);
  const oversold=syncStatus({...t,closes:[close('2026-10-10',2,30),close('2026-10-18',2,30)]});assert.equal((await h.trades.PUT(h.req('/api/trades','PUT',oversold))).status,400);
  t=await save(h,syncStatus({...t,entries:t.entries.map((e,i)=>i===1?{...e,price:2520,fees:3}:e),summary:'跨周总结'}));d=await data(h);assert.equal(d.trades[0].entryPrice,2500);assert.deepEqual(d.records,[day]);assert.deepEqual(d.settings,settings);
  assert((await (await h.trades.GET(h.req('/api/trades?id='+t.id))).json()).history.some(v=>v.changes.some(c=>c.field==='entries'&&c.before?.[1]?.price===2510&&c.after?.[1]?.price===2520)));h.sql.close();
});
test('phase 1: daily draft screenshots are durable, owner-private and editable without adding a formal day',async()=>{
  const h=apiHarness(),day=blankDay('2026-10-09'),form=()=>{const f=uploadForm({id:'daily:'+day.date,model:'S1'});f.set('entityType','daily');f.set('dailyDate',day.date);f.set('stage','每日市场观察');return f;};
  assert.equal((await h.images.POST(h.req('/api/images','POST',form()))).status,404);
  assert.equal((await h.drafts.PUT(h.req('/api/drafts?date='+day.date,'PUT',{...day,marketState:'transition',oneHourTrend:'LH回测',zones:'人工阻力',marketHypothesis:'等待回踩',macroInfo:'已记录事件'}))).status,200);
  let r=await h.images.POST(h.req('/api/images','POST',form()));assert.equal(r.status,200);let i=(await r.json()).image;assert.equal(i.entityType,'daily');assert.equal(i.dailyDate,day.date);
  assert.equal((await data(h)).records.length,0);assert.equal((await h.images.GET(h.req('/api/images?id='+i.id))).status,200);
  const reload=await (await h.images.GET(h.req('/api/images?tradeId='+encodeURIComponent('daily:'+day.date)))).json();assert.equal(reload.images[0].id,i.id);
  h.setUser({userId:'B'});assert.equal((await h.images.GET(h.req('/api/images?id='+i.id))).status,404);assert.equal((await h.images.POST(h.req('/api/images','POST',form()))).status,404);h.setUser({userId:'A'});
  r=await h.images.PUT(h.req('/api/images?id='+i.id,'PUT',form()));assert.equal(r.status,200);assert.equal((await r.json()).image.dailyDate,day.date);assert.equal(h.objects.size,1);
  const draft=await (await h.drafts.GET(h.req('/api/drafts?date='+day.date))).json();r=await h.records.PUT(h.req('/api/records','PUT',draft.draft.record));assert.equal(r.status,200);assert.equal((await data(h)).records[0].oneHourTrend,'LH回测');assert.equal((await h.images.GET(h.req('/api/images?id='+i.id))).status,200);
  assert.equal((await h.images.DELETE(h.req('/api/images?id='+i.id,'DELETE'))).status,200);assert.equal(h.objects.size,0);
  assert((await (await h.history.GET(h.req('/api/history?type=daily&id='+day.date))).json()).history.some(v=>v.changes.some(c=>c.field==='截图:'+i.id&&c.after===null)));h.sql.close();
});
