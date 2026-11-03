import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { DEMO_SETTINGS as DEFAULT_SETTINGS } from './demo-settings.mjs';
import { blankDay, dailySchema, dailyDraftSchema, generateDemo } from '../lib/domain.ts';
import { growthSummary, readiness, fatigueSummary, weeklyWellbeing, weeklyReport, weeklyMarkdown } from '../lib/wellbeing.ts';
import { saveRecord, loadData, saveDraft, loadDraft, loadDrafts, deleteDraft } from '../lib/repository.ts';
import { dailyCSV } from '../lib/exports.ts';

const settings={...DEFAULT_SETTINGS,riskLimit:400};
const trade=(netPnl)=>({id:crypto.randomUUID(),model:'S1',netPnl,initialRisk:100,inPlan:true});
const day=(date,wellbeing,extra={})=>({...blankDay(date),...(wellbeing?{wellbeing}:{}),...extra});
export function database(){const sql=new DatabaseSync(':memory:');for(const file of ['0000_flaky_sentinels.sql','0001_blue_black_cat.sql'])sql.exec(readFileSync(new URL('../drizzle/'+file,import.meta.url),'utf8'));return {sql,db:{prepare(query){let params=[];const stmt=sql.prepare(query);return {bind(...p){params=p;return this;},async all(){return {results:stmt.all(...params)};},async first(){return stmt.get(...params)??null;},async run(){stmt.run(...params);return {success:true};}};}}};}

test('legacy records parse byte-equivalently without fabricated health values; examples contain none',()=>{
  const legacy=blankDay('2026-10-10');assert.deepEqual(dailySchema.parse(legacy),legacy);assert(!('wellbeing' in dailySchema.parse(legacy)));
  const s=growthSummary([legacy],'2026-10-11',14,settings);assert.equal(s.meanStress,null);assert.equal(s.meanEnergy,null);assert.equal(s.meanSleep,null);assert.equal(s.stressCount,0);assert.equal(s.records.length,1);
  assert(generateDemo().every(d=>d.wellbeing===undefined));
});
test('optional values distinguish real zero/false from missing and validate ratings, sleep and event context',()=>{
  const zero=day('2026-10-10',{stress:0,worry:null,energy:0,sleepHours:0,exercised:false});assert.equal(dailySchema.safeParse(zero).success,true);
  const s=growthSummary([zero],'2026-10-11',14,settings);assert.equal(s.meanStress,0);assert.equal(s.meanEnergy,0);assert.equal(s.meanSleep,0);assert.equal(s.trend.find(p=>p.date==='2026-10-10').worry,null);
  for(const wellbeing of [{stress:11},{stress:-1},{worry:1.5},{energy:NaN},{sleepHours:25},{trigger:'x'.repeat(5001)},{violationContexts:[{time:'25:00',fatigued:true}]}])assert.equal(dailySchema.safeParse(day('2026-10-10',wellbeing)).success,false);
  const inconsistent=day('2026-10-10',{violationContexts:[{time:'19:30',fatigued:true}]});assert.equal(dailySchema.safeParse(inconsistent).success,false);
  assert.equal(dailyDraftSchema.safeParse({...zero,violations:1,planCompliant:true}).success,true);
  assert.equal(dailySchema.safeParse({...zero,violations:1,planCompliant:true}).success,false);
});
test('readiness separates unknown, good, cautious and pause; risk triggers use existing FOMO/impulses',()=>{
  assert.equal(readiness(blankDay()).status,'unknown');
  const good=day('2026-10-10',{stress:3,worry:3,energy:7,sleepHours:7});assert.equal(readiness(good).status,'good');
  for(const patch of [{stress:4},{energy:6},{sleepHours:5.5}])assert.equal(readiness({...good,wellbeing:{...good.wellbeing,...patch}}).status,'cautious');
  for(const patch of [{stress:8},{worry:8},{energy:3},{sleepHours:4.9},{energy:0}])assert.equal(readiness({...good,wellbeing:{...good.wellbeing,...patch}}).status,'pause');
  const risks=readiness({...good,fomo:7,impulses:1,wellbeing:{...good.wellbeing,recoveryUrgency:true,impulsiveReversal:true}});assert.equal(risks.status,'cautious');assert.equal(risks.warnings.length,4);
  assert.equal(readiness(day('2026-10-10',{energy:2})).partial,true);
});
test('14/30-day date windows, missing calendar gaps and relationships use paired actual records only',()=>{
  const records=[day('2026-09-11',{stress:9,energy:1}),day('2026-09-12',{stress:2,energy:8}),day('2026-09-27',{stress:0,energy:9,sleepHours:8},{trades:[trade(100)],fomo:1}),day('2026-10-01',{stress:8,energy:2,sleepHours:4},{violations:2,planCompliant:false,trades:[trade(-50),trade(0)],fomo:8}),day('2026-10-10',null,{violations:4,planCompliant:false}),day('2026-10-11',{stress:10,energy:0})];
  const s=growthSummary(records,'2026-10-10',14,settings);assert.equal(s.start,'2026-09-27');assert.equal(s.records.length,3);assert.equal(s.trend.length,14);assert.equal(s.trend.find(d=>d.date==='2026-10-02').energy,null);
  assert.equal(s.stressCount,2);assert.equal(s.meanStress,4);assert.equal(s.energy[0].complianceRate,0);assert.equal(s.energy[2].complianceRate,100);assert.equal(s.stress[2].averageViolations,2);
  assert.equal(s.fomo[0].profit,100);assert.equal(s.fomo[2].loss,50);assert.equal(s.fomo[2].flat,1);assert.equal(s.fomo[2].averagePnl,-25);
  const month=growthSummary(records,'2026-10-10',30,settings);assert.equal(month.start,'2026-09-11');assert.equal(month.records.length,5);assert.equal(month.meanStress,19/4);
});
test('fatigue time analysis cannot infer event fatigue from a low daily energy score or partial events',()=>{
  const noTime=day('2026-10-10',{energy:1},{violations:2,planCompliant:false});assert.match(fatigueSummary([noTime]).text,/数据不足/);
  const partial={...noTime,wellbeing:{energy:1,violationContexts:[{time:'19:30',fatigued:true},{time:null,fatigued:true}]}};
  const p=fatigueSummary([partial]);assert.equal(p.known,1);assert.equal(p.complete,false);assert.match(p.text,/无法判断全部/);assert.equal(p.timeBands[3].tired,1);
  const complete={...partial,wellbeing:{...partial.wellbeing,violationContexts:[{time:'05:59',fatigued:true},{time:'06:00',fatigued:false}]}};
  const c=fatigueSummary([complete]);assert.equal(c.complete,true);assert.equal(c.timeBands[0].tired,1);assert.equal(c.timeBands[1].events,1);assert.equal(c.tired,1);assert.match(c.text,/次数较少/);
});
test('weekly mood proxy requires comparable days, preserves ties and never claims intraday volatility',()=>{
  const records=[day('2026-10-05',{stress:0,energy:8}),day('2026-10-06',{stress:8,worry:4,energy:0}),day('2026-10-07',{stress:5,worry:8})];
  assert.equal(weeklyWellbeing(records.slice(0,2)).unstableDates.length,0);
  const w=weeklyWellbeing(records);assert.deepEqual(w.unstableDates,['2026-10-06','2026-10-07']);assert.equal(w.meanStress,13/3);assert.equal(w.meanEnergy,4);assert.equal(w.energyCount,2);
});
test('Sunday report uses current Monday through cutoff, actual period intersection and full-history drawdown',()=>{
  const all=[day('2026-10-10',null,{trades:[trade(100)]}),day('2026-10-11',{stress:7,worry:7,energy:3},{trades:[trade(-50)]}),day('2026-10-12',{stress:0,energy:10},{trades:[trade(999)]})];
  const first=weeklyReport(all,settings,'2026-10-11','2026-10-11');assert.equal(first.start,'2026-10-10');assert.equal(first.end,'2026-10-11');assert.equal(first.stats.totalPnl,50);assert.equal(first.wellbeing.meanStress,7);
  const later=[...all,day('2026-10-14',{energy:2},{trades:[trade(-1200)]})];
  const report=weeklyReport(later,settings,'2026-10-18','2026-10-18');assert.equal(report.start,'2026-10-12');assert.equal(report.stats.maxDrawdown,1200);
  const md=weeklyMarkdown(first);assert.match(md,/覆盖 1\/2 天/);assert.match(md,/情绪波动/);assert.match(md,/草稿不参与统计/);assert(!md.includes('2026-10-12'));
});
test('existing SQLite rows stay intact after new migration; drafts persist, isolate owners and clear only on confirmation',async()=>{
  const {sql,db}=database();const legacy=blankDay('2026-10-10');await saveRecord(db,'A',legacy);
  const before=sql.prepare('SELECT data, updated_at FROM daily_records WHERE owner_id=?').get('A');
  const draft=day('2026-10-11',{stress:8,energy:2,sleepHours:4,trigger:'连续中文长文字'.repeat(400)},{note:'\n含换行的草稿'.repeat(400)});await saveDraft(db,'A',draft);
  assert.deepEqual((await loadDraft(db,'A',draft.date)).record,draft);assert.equal(await loadDraft(db,'B',draft.date),null);assert.deepEqual(await loadDrafts(db,'B'),[]);
  assert.deepEqual((await loadData(db,'A')).records,[legacy]);assert.deepEqual(sql.prepare('SELECT data, updated_at FROM daily_records WHERE owner_id=?').get('A'),before);
  await deleteDraft(db,'B',draft.date);assert.equal((await loadDrafts(db,'A')).length,1);
  await saveRecord(db,'A',draft);assert.equal((await loadData(db,'A')).records.length,2);assert.equal((await loadData(db,'A')).records[1].wellbeing.sleepHours,4);assert.equal(await loadDraft(db,'A',draft.date),null);
  const after=sql.prepare('SELECT data, updated_at FROM daily_records WHERE owner_id=? AND date=?').get('A',legacy.date);assert.deepEqual(after,before);sql.close();
});
test('CSV exports added state values without duplicating FOMO; unknowns stay blank and text formulas stay escaped',()=>{
  const csv=dailyCSV([day('2026-10-10',{stress:0,exercised:false,trigger:'=HYPERLINK("x")'},{note:'中文,\n长文字'})],settings);
  const header=csv.split('\r\n')[0];assert.equal((header.match(/"FOMO"/g)??[]).length,1);assert.match(header,/情绪压力/);assert.match(csv,/'=HYPERLINK/);assert.match(csv,/"0","","","","否"/);assert.match(csv,/"中文,\n长文字"/);
});
