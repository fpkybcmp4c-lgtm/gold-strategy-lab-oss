import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_SETTINGS as DEFAULT_SETTINGS } from './demo-settings.mjs';
import {DEFAULT_UNIFIED_ACCOUNT,unknownContract} from '../lib/multi-asset.ts';
import {knownContractProfile} from '../lib/contract-profiles.ts';
import {blankTrade} from '../lib/trading.ts';
import {planCalculation,tradeContract,closeCalculation} from '../lib/calculations.ts';
// Demo: invented prices, quantities, fees and balance; never imported from a trading account.
const settings={...DEFAULT_SETTINGS,capital:20000,multiAsset:{unifiedAccount:{...DEFAULT_UNIFIED_ACCOUNT,capital:20000}}};
const sample=()=>({...blankTrade('2026-10-20'),instrument:'NQ',symbol:'QQQUSDT.P',accountId:'demo-account',framework:'pending',model:'其他',direction:'short',entryPrice:100,quantity:6,originalStop:104,currentStop:104,targetPrice:91,initialRisk:null,contract:unknownContract(),entries:[{id:'demo-entry',date:'2026-10-20',time:'09:00',quantity:6,price:100,fees:3,feeSource:'actual',rationale:'Demo',inPlan:true,lossAdd:null}]});
test('known QQQ base-quantity contract resolves without rewriting saved metadata or inventing costs',()=>{
 const t=sample(),before=JSON.stringify(t),p=planCalculation(t,settings);
 assert.equal(p.priceRisk,24);assert.equal(p.targetGross,54);assert.equal(p.grossRR,2.25);assert.equal(p.entryFees,3);
 assert.equal(p.knownRiskFloor,27);assert.equal(p.knownRiskPct,.135);assert.equal(p.totalRisk,null);
 assert.deepEqual(p.unknownRiskCosts,['预计平仓手续费','滑点预算']);assert.equal(t.initialRisk,null);assert.equal(JSON.stringify(t),before);
 const close={id:'demo-close',date:'2026-10-20',time:'10:00',quantity:3,price:91,fees:1.5,netPnl:0,reason:'Demo'};
 const result=closeCalculation(t,close,settings);assert.equal(result.gross,27);assert.equal(result.allocatedEntryFee,1.5);assert.equal(result.net,24);
});
test('different NQ contracts, inverse contracts and explicit multipliers never share one guessed formula',()=>{
 assert.equal(knownContractProfile('MNQ').usdPerPriceUnit,2);assert.equal(knownContractProfile('NQ').usdPerPriceUnit,20);
 assert.equal(knownContractProfile('BTCUSDT.P').usdPerPriceUnit,1);assert.equal(knownContractProfile('BTCUSD'),null);
 let t=sample();t.contract={...t.contract,confirmed:true,usdPerPriceUnit:7,currency:'USD'};assert.equal(tradeContract(t,settings).usdPerPriceUnit,7);
 t={...sample(),contract:{...unknownContract(),settlement:'inverse'}};assert.equal(planCalculation(t,settings).priceRisk,null);
 t={...sample(),symbol:'UNRECOGNIZED'};assert.equal(planCalculation(t,settings).priceRisk,null);
 t={...sample(),contract:{...unknownContract(),currency:'CNY'}};assert.equal(planCalculation(t,settings).priceRisk,null);
});
test('a once-configured actual product multiplier takes precedence over a default code profile',()=>{
 const configured={...settings,multiAsset:{...settings.multiAsset,instruments:{NQ:{symbol:'QQQUSDT.P',contract:{...knownContractProfile('QQQUSDT'),usdPerPriceUnit:3}}}}};
 assert.equal(planCalculation(sample(),configured).priceRisk,72);
});
