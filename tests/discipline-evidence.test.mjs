import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_SETTINGS as DEFAULT_SETTINGS } from './demo-settings.mjs';
import { blankDay, discipline, assessedDiscipline, summarize } from '../lib/domain.ts';
import {blankTrade} from '../lib/trading.ts';
import {ledgerDays} from '../lib/ledger.ts';
import {dailyDisciplineEvidence} from '../lib/discipline-evidence.ts';
const date='2026-10-14';
test('a fully compliant daily self assessment cannot erase saved risk and unplanned entry evidence',()=>{
  const day={...blankDay(date),disciplineAssessed:true};const trade={...blankTrade(date),entryPrice:4162,quantity:9,framework:'independent',riskCompliant:false,initialRisk:220,inPlan:false};
  const raw=JSON.stringify(day),record=JSON.stringify(trade),projected=ledgerDays([day],[trade],'USD')[0];
  assert.equal(discipline(day,400),100);assert(discipline(projected,400)<100);assert.equal(projected.executionDiscipline.riskViolation,true);assert.equal(projected.executionDiscipline.planDeviation,true);assert.equal(projected.executionDiscipline.minimumViolations,1);assert.equal(summarize([projected],{...DEFAULT_SETTINGS,riskLimit:400}).complianceRate,0);assert.equal(JSON.stringify(day),raw);assert.equal(JSON.stringify(trade),record);
});
test('unknown emotions and losing outcomes are not discipline violations or zero ratings',()=>{
  const t={...blankTrade(date),entryPrice:4162,quantity:1,riskCompliant:null};assert.equal(dailyDisciplineEvidence([t],date).evidence.length,0);assert.equal(assessedDiscipline({...blankDay(date),disciplineAssessed:false,executionDiscipline:dailyDisciplineEvidence([t],date)},400),null);
});
test('saved event dates attribute explicit unplanned adds without fabricating a repeated daily event',()=>{
  const t={...blankTrade('2026-10-13'),entries:[{id:'entry',date:'2026-10-13',time:null,quantity:1,price:100,fees:null,inPlan:true,lossAdd:null,rationale:''},{id:'add',date,time:null,quantity:1,price:101,fees:null,inPlan:false,lossAdd:true,rationale:''}]};
  assert.equal(dailyDisciplineEvidence([t],'2026-10-13').evidence.length,0);const a=dailyDisciplineEvidence([t,t],date);assert.equal(a.minimumViolations,1);assert.equal(a.evidence.length,2);assert.equal(a.riskViolation,true);
});
