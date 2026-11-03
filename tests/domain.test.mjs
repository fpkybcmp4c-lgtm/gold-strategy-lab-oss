import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { DEMO_SETTINGS as DEFAULT_SETTINGS } from './demo-settings.mjs';
import { DEFAULT_SETTINGS as APP_DEFAULT_SETTINGS } from '../lib/domain.ts';
import { blankDay, equitySeries, summarize, aggregate, filterRecords, periodKey, discipline, dailySchema, settingsSchema, generateDemo, recordR, evaluation, dayDistance } from '../lib/domain.ts';
import { loadData, saveRecord, deleteRecord, saveSettings } from '../lib/repository.ts';

const settings={...DEFAULT_SETTINGS,capital:1000};
const trade=(netPnl,initialRisk=100,inPlan=true,id=crypto.randomUUID())=>({id,model:'S1',netPnl,initialRisk,inPlan});
const day=(date,trades=[],extra={})=>({...blankDay(date),trades,...extra});
const samples=[day('2026-10-10',[trade(300)]),day('2026-10-11',[trade(-200,200)]),day('2026-10-12',[trade(-100,null)]),day('2026-11-01')];

test('net profit and per-trade R use only closed net results; unknown risk stays excluded',()=>{
  const s=summarize(samples,settings);
  assert.equal(s.totalPnl,0);assert.equal(s.trades,3);assert.equal(s.knownR,2);assert.equal(s.totalR,2);assert.equal(s.expectancy,1);assert.equal(s.profitFactor,1);assert.equal(s.winRate,100/3);
  assert.equal(recordR(samples[2]),null);assert.equal(recordR(samples[3]),null);
});
test('drawdown includes initial account and preserved high water when filters select later days',()=>{
  const p=equitySeries(samples,settings);assert.deepEqual(p.map(v=>v.cumulative),[300,100,0,0]);assert.deepEqual(p.map(v=>v.drawdown),[0,200,300,300]);
  const f=filterRecords(p,{start:'2026-10-12',end:'2026-10-12',compliance:'all',model:'all'});
  assert.equal(summarize(f,settings,f).maxDrawdown,300);assert.equal(f[0].drawdownPct,300/1300*100);
  const firstLoss=equitySeries([day('2026-10-10',[trade(-200)])],settings);assert.equal(firstLoss[0].drawdown,200);
});
test('validation dates exclude pre-period Oct 9 and post-period references',()=>{
  const p=equitySeries([day('2026-10-09',[trade(-800)]),...samples,day('2027-01-10',[trade(999)])],settings);
  assert.equal(p.length,4);assert.equal(p.at(-1).cumulative,0);assert.equal(dayDistance(DEFAULT_SETTINGS.start,DEFAULT_SETTINGS.end)+1,92);
});
test('weekly and monthly aggregations preserve sums, average actual check-in days and max drawdown',()=>{
  const p=equitySeries(samples,settings);assert.equal(periodKey('2026-10-11','week'),'2026-10-05');assert.equal(periodKey('2026-10-12','week'),'2026-10-12');
  const w=aggregate(p,settings,'week');assert.equal(w[0].days,2);assert.equal(w[0].totalPnl,100);assert.equal(w[0].maxDrawdown,200);
  const m=aggregate(p,settings,'month');assert.equal(m.length,2);assert.equal(m[0].days,3);assert.equal(m[1].trades,0);
  for(const granularity of ['day','week','month'])assert.equal(aggregate(p,settings,granularity).reduce((s,v)=>s+v.totalPnl,0),0);
});
test('date, compliance and model filters select days consistently, including empty results',()=>{
  const ds=[...samples,day('2026-10-14',[{...trade(-50),model:'L2',inPlan:false}],{planCompliant:false,violations:1})];
  assert.deepEqual(filterRecords(ds,{start:'2026-10-10',end:'2026-10-20',compliance:'no',model:'L2'}).map(d=>d.date),['2026-10-14']);
  assert.equal(filterRecords(ds,{start:'2026-10-20',end:'2026-10-10',compliance:'all',model:'all'}).length,0);
  assert.equal(filterRecords(ds,{start:'2026-10-10',end:'2026-10-20',compliance:'yes',model:'L2'}).length,0);
});
test('discipline scores actions; high FOMO and a no-trade day are not penalized',()=>{
  assert.equal(discipline(day('2026-10-10',[],{fomo:10})),100);
  assert.equal(discipline(day('2026-10-10',[],{planCompliant:false,violations:2,impulses:1})),45);
  assert.equal(discipline(day('2026-10-10',[trade(100,600)]),500),75);
  assert.equal(discipline(day('2026-10-10',[],{planCompliant:false,riskCompliant:false,violations:100,impulses:100})),0);
});
test('validation rejects impossible dates, inconsistent compliance, negative counters, zero risks and nonfinite PnL',()=>{
  assert.equal(dailySchema.safeParse(day('2026-02-30')).success,false);
  assert.equal(dailySchema.safeParse(day('2026-10-10',[],{violations:1})).success,false);
  assert.equal(dailySchema.safeParse(day('2026-10-10',[],{fomo:11})).success,false);
  assert.equal(dailySchema.safeParse(day('2026-10-10',[],{newTrades:-1})).success,false);
  assert.equal(dailySchema.safeParse(day('2026-10-10',[trade(0,0)])).success,false);
  assert.equal(dailySchema.safeParse(day('2026-10-10',[trade(Infinity)])).success,false);
  assert.equal(settingsSchema.safeParse({...settings,end:'2026-10-01'}).success,false);
});
test('demo provides valid win, loss, missing risk, no-trade and violation records across the application period; live starts empty',()=>{
  const demo=generateDemo();assert.equal(demo.length,46);demo.forEach(d=>assert.equal(dailySchema.safeParse(d).success,true));
  assert(demo.some(d=>d.trades.some(t=>t.initialRisk===null)));assert(demo.some(d=>d.trades.length===0));assert(demo.some(d=>d.violations>0));
  const p=equitySeries(demo,APP_DEFAULT_SETTINGS);assert.equal(aggregate(p,APP_DEFAULT_SETTINGS,'month').length,3);
  const total=p.reduce((s,d)=>s+d.dailyPnl,0);for(const g of ['day','week','month'])assert.equal(aggregate(p,APP_DEFAULT_SETTINGS,g).reduce((s,d)=>s+d.totalPnl,0),total);
  const s=summarize([],APP_DEFAULT_SETTINGS);assert.equal(s.totalPnl,0);assert.equal(s.score,null);assert.equal(s.expectancy,null);
});
test('stage assessment requires enough planned trades and separates execution from strategy',()=>{
  assert.equal(evaluation(samples,settings).title,'继续收集样本');
  const good=Array.from({length:30},(_,i)=>day('2026-10-'+String(10+i%20).padStart(2,'0'),[trade(50)]));
  assert.equal(evaluation(good,settings).title,'出现正期望迹象');
  const bad=good.map(d=>({...d,planCompliant:false,violations:2}));assert.equal(evaluation(bad,settings).title,'优先修复执行');
  const losses=good.map(d=>({...d,trades:[trade(-50)]}));assert.equal(evaluation(losses,settings).title,'需要检查模型');
});

function d1Adapter(sqlite){return {prepare(sql){let params=[];const stmt=sqlite.prepare(sql);return {bind(...p){params=p;return this;},async all(){return {results:stmt.all(...params)};},async first(){return stmt.get(...params)??null;},async run(){stmt.run(...params);return {success:true};}};}};}
test('actual SQLite migration + D1 SQL: create, reload, edit without duplicate, delete and owner isolation',async()=>{
  const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('../drizzle/0000_flaky_sentinels.sql',import.meta.url),'utf8'));sql.exec(readFileSync(new URL('../drizzle/0001_blue_black_cat.sql',import.meta.url),'utf8'));const db=d1Adapter(sql);
  assert.deepEqual((await loadData(db,'A')).records,[]);
  const d=day('2026-10-10',[trade(300)]);await saveRecord(db,'A',d);await saveSettings(db,'A',settings);
  assert.deepEqual((await loadData(db,'A')).records,[d]);assert.deepEqual((await loadData(db,'A')).settings,settings);
  assert.deepEqual((await loadData(db,'B')).records,[]);
  const updated={...d,note:'edited',trades:[trade(-100,100)]};await saveRecord(db,'A',updated);assert.equal((await loadData(db,'A')).records.length,1);assert.equal((await loadData(db,'A')).records[0].trades[0].netPnl,-100);
  await deleteRecord(db,'B',d.date);assert.equal((await loadData(db,'A')).records.length,1);
  await deleteRecord(db,'A',d.date);assert.deepEqual((await loadData(db,'A')).records,[]);sql.close();
});
