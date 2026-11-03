import type { Settings } from './domain.ts';
import { g1Config } from './g1.ts';
import type { ContractConfig } from './g1-schema.ts';
import { tradeCurrency, finalDate, hasExecution, instrumentOf, isLegacySummary, orderedCloses, totalRealized } from './trading.ts';
import type { CloseEvent, TradeRecord } from './trading.ts';
import { accountConfig, accountOf, instrumentConfig, ledgerContract, unifiedAccountConfig } from './multi-asset.ts';
import { knownContractProfile, normalizeContractCode } from './contract-profiles.ts';

export function tradeContract(t:TradeRecord,s:Settings):ContractConfig{
  const config=instrumentConfig(s,instrumentOf(t)),raw=t.contract??(instrumentOf(t)==='XAU'?t.g1?.contract:undefined);
  if(!unifiedAccountConfig(s))return raw??config.contract;
  const saved=ledgerContract(raw??config.contract,s);
  if(raw?.confirmed||saved.settlement==='inverse')return saved;
  const configured=normalizeContractCode(t.symbol??config.symbol)===normalizeContractCode(config.symbol)&&config.contract.confirmed?config.contract:null;
  const profile=configured??knownContractProfile(t.symbol??config.symbol);if(!profile)return saved;
  if(saved.currency&&saved.currency!=='UNKNOWN'&&saved.currency!==profile.currency)return saved;
  // A saved explicit multiplier or special settlement can never be overwritten by a profile.
  if(saved.usdPerPriceUnit!=null&&saved.usdPerPriceUnit!==profile.usdPerPriceUnit)return saved;
  const retained=Object.fromEntries(Object.entries(saved).filter(([key,value])=>value!=null&&!['confirmed','currency','feeMode'].includes(key)));
  return ledgerContract({...profile,...retained,confirmed:true,currency:profile.currency,...(saved.feeMode==='notional'?{feeMode:saved.feeMode}:{})},s);
}
const finitePositive = (n: number | null | undefined): n is number => n != null && Number.isFinite(n) && n > 0;
const finiteNonnegative = (n:number|null|undefined):n is number => n!=null&&Number.isFinite(n)&&n>=0;
const money = (n: number) => Math.round((n + Number.EPSILON) * 1e8) / 1e8;
export const linearContract = (c:ContractConfig) => (c.settlement===undefined||c.settlement==='linear') && c.currency!=='UNKNOWN' && (!c.feeCurrency||c.feeCurrency===(c.currency??'USD'));
export function estimatedExecutionFee(c:ContractConfig,quantity:number|null,price:number|null,side:'entry'|'exit'):number|null {
  if(!linearContract(c)||!c.confirmed||!finitePositive(quantity))return null;
  if(c.feeMode==='notional'){
    const rate=side==='entry'?c.entryFeeRate:c.exitFeeRate;
    return finitePositive(price)&&finitePositive(c.usdPerPriceUnit)&&rate!=null&&Number.isFinite(rate)&&rate>=0 ? money(quantity*price*c.usdPerPriceUnit*rate) : null;
  }
  if(c.feeMode!==undefined&&c.feeMode!=='perQuantity')return null;
  const fee=side==='entry'?c.entryFeePerQty:c.exitFeePerQty;
  return fee!=null&&Number.isFinite(fee)&&fee>=0 ? money(quantity*fee) : null;
}
export function calculationContractReady(c:ContractConfig){return linearContract(c)&&c.confirmed&&finitePositive(c.usdPerPriceUnit)&&finiteNonnegative(c.slippagePrice)&&(c.feeMode==='notional'?finiteNonnegative(c.entryFeeRate)&&finiteNonnegative(c.exitFeeRate):(c.feeMode===undefined||c.feeMode==='perQuantity')&&finiteNonnegative(c.entryFeePerQty)&&finiteNonnegative(c.exitFeePerQty));}

/** A projection only: saved initialRisk and actual close amounts are never changed here. */
export function planCalculation(t: TradeRecord, s: Settings, budget:number|null = instrumentOf(t)==='XAU'?t.g1?.riskBudget ?? g1Config(s).normalRiskMax:instrumentConfig(s,instrumentOf(t)).normalRisk) {
  const config=instrumentConfig(s,instrumentOf(t)),account=accountConfig(s,accountOf(t,s));
  const c = tradeContract(t, s),sameCurrency=!!account&&(c.currency??'USD')===account.currency, q = t.quantity, entry = t.entryPrice, stop = t.originalStop, target = t.targetPrice;
  const knownProduct = linearContract(c) && (c.currency!==undefined||instrumentOf(t)==='XAU') && c.confirmed && finitePositive(c.usdPerPriceUnit);
  const stopDistance = finitePositive(entry) && finitePositive(stop) && t.direction ? (t.direction === 'short' ? stop-entry : entry-stop) : null;
  const targetDistance = finitePositive(entry) && finitePositive(target) && t.direction ? (t.direction === 'short' ? entry-target : target-entry) : null;
  const priceRisk = knownProduct && finitePositive(q) && stopDistance !== null && stopDistance > 0 ? money(stopDistance*q*c.usdPerPriceUnit!) : null;
  const targetGross=knownProduct&&finitePositive(q)&&targetDistance!==null&&targetDistance>0?money(targetDistance*q*c.usdPerPriceUnit!):null;
  const grossRR=priceRisk!==null&&priceRisk>0&&targetGross!==null?targetGross/priceRisk:null;
  const allEntryFeesRecorded=!!t.entries?.length&&t.entries.every(e=>finiteNonnegative(e.fees));
  const entryFeeParts=t.entries?.length?t.entries.map(e=>finiteNonnegative(e.fees)?e.fees:estimatedExecutionFee(c,e.quantity,e.price,'entry')):null;
  const entryFees = allEntryFeesRecorded ? money(t.entries!.reduce((n,e) => n+e.fees!,0)) : finiteNonnegative(t.aggregateEntryFee)?t.aggregateEntryFee:entryFeeParts?entryFeeParts.every((v):v is number=>v!==null)?money(entryFeeParts.reduce((n,v)=>n+v,0)):null:estimatedExecutionFee(c,q,entry,'entry');
  const exitFees = estimatedExecutionFee(c,q,stop,'exit');
  const fees = entryFees !== null && exitFees !== null ? money(entryFees+exitFees) : null;
  const slippage = knownProduct && finitePositive(q) && finiteNonnegative(c.slippagePrice) ? money(q*c.slippagePrice*c.usdPerPriceUnit!) : null;
  const totalRisk = priceRisk !== null && fees !== null && slippage !== null ? money(priceRisk+fees+slippage) : null;
  const unknownRiskCosts=[...(entryFees===null?['开仓手续费']:[]),...(exitFees===null?['预计平仓手续费']:[]),...(slippage===null?['滑点预算']:[])];
  const knownRiskFloor=priceRisk===null?null:money(priceRisk+(entryFees??0)+(exitFees??0)+(slippage??0));
  const targetExitFees=estimatedExecutionFee(c,q,target,'exit');
  const targetNet = knownProduct && finitePositive(q) && targetDistance !== null && targetDistance > 0 && entryFees !== null && targetExitFees!==null && slippage !== null ? money(targetDistance*q*c.usdPerPriceUnit!-entryFees-targetExitFees-slippage) : null;
  const unitEntryFee=estimatedExecutionFee(c,1,entry,'entry'),unitExitFee=estimatedExecutionFee(c,1,stop,'exit');
  const rawMaximum = sameCurrency && calculationContractReady(c) && stopDistance !== null && stopDistance > 0 && budget!==null&&budget > 0 && unitEntryFee!==null&&unitExitFee!==null ? budget/(stopDistance*c.usdPerPriceUnit!+unitEntryFee+unitExitFee+c.slippagePrice!*c.usdPerPriceUnit!) : null;
  const maximum = rawMaximum === null ? null : c.quantityStep ? Math.floor((rawMaximum+1e-10)/c.quantityStep)*c.quantityStep : rawMaximum;
  const executableMaximum = maximum === null || c.minimumQuantity != null && maximum<c.minimumQuantity ? null : money(maximum);
  return { stopDistance, targetDistance, priceRisk,targetGross,grossRR,knownRiskFloor,unknownRiskCosts,knownRiskPct:sameCurrency&&account?.capital!=null&&knownRiskFloor!==null?100*knownRiskFloor/account.capital:null, entryFees, exitFees, fees, slippage, totalRisk, targetNet, netRR:totalRisk !== null && totalRisk>0 && targetNet !== null ? targetNet/totalRisk : null, currencyMismatch:!sameCurrency,riskPct:sameCurrency && account?.capital!=null && totalRisk !== null ? 100*totalRisk/account.capital : null, maximum:executableMaximum, quantityPrecisionKnown:c.quantityStep !== null, overHard:sameCurrency && totalRisk !== null && config.riskLimit!==null ? totalRisk>config.riskLimit+1e-8 : null, overNormal:sameCurrency && totalRisk !== null && budget!==null ? totalRisk>budget+1e-8 : null, estimatedEntryFee:!!t.entries?.some(e=>e.feeSource==='estimated')||!(t.entries?.length && t.entries.every(e=>e.fees!==null)) && t.aggregateEntryFee==null, currency:c.currency ?? (instrumentOf(t)==='XAU'?'USD':'UNKNOWN'), ready:totalRisk!==null };
}

/** Moving weighted average, including entry-cost allocation, through interleaved executions. */
export function closeCalculation(t: TradeRecord, close: CloseEvent, s: Settings) {
  const c=tradeContract(t,s),clock=(time:string|null,fallback:string)=>time?.length===5?time+':00':time??fallback,cutoff=close.date+'T'+clock(close.time,'23:59:59');
  let quantity=0, basis=0, entryCost=0, entryCostKnown=true,entryFeeEstimated=false,inventoryValid=true;
  const entries=t.entries?.length ? t.entries : t.entryPrice!==null && t.quantity!==null && t.openedDate ? [{id:'aggregate',date:t.openedDate,time:t.openedTime,quantity:t.quantity,price:t.entryPrice,fees:t.aggregateEntryFee??null,feeSource:'actual' as const}] : [];
  const events=[...entries.map(e=>({key:e.date+'T'+clock(e.time,'00:00:00'),entry:e,close:null})),...t.closes.filter(e=>e.id!==close.id).map(e=>({key:e.date+'T'+clock(e.time,'23:59:59'),entry:null,close:e}))].filter(e=>e.key<cutoff||e.key===cutoff&&(e.entry||e.close!.id<close.id)).sort((a,b)=>a.key.localeCompare(b.key)||(a.entry&&b.entry?a.entry.id.localeCompare(b.entry.id):a.entry?-1:b.entry?1:a.close!.id.localeCompare(b.close!.id)));
  // At identical times closes are matched in stable ID order, same as validation/order projection.
  for(const e of events){
    if(e.entry){if(!finitePositive(e.entry.quantity)||!finitePositive(e.entry.price))inventoryValid=false;quantity+=e.entry.quantity;basis+=e.entry.quantity*e.entry.price;if(!finiteNonnegative(e.entry.fees))entryCostKnown=false;else entryCost=money(entryCost+e.entry.fees);if(e.entry.feeSource==='estimated')entryFeeEstimated=true;}
    else if(e.close){
      const q=e.close.quantity,tolerance=quantity*1e-8;
      if(!finitePositive(q)||q>quantity+tolerance){inventoryValid=false;continue;}
      const fraction=quantity>0?Math.min(1,q/quantity):0;
      basis*=1-fraction;entryCost=money(entryCost-money(entryCost*fraction));quantity=Math.max(0,quantity-q);
      if(quantity<=tolerance){quantity=0;basis=0;entryCost=0;entryCostKnown=true;entryFeeEstimated=false;}
    }
  }
  const q=close.quantity, average=quantity>0?basis/quantity:null;
  const valid=inventoryValid && linearContract(c) && (c.currency!==undefined||instrumentOf(t)==='XAU') && finitePositive(q) && q<=quantity+quantity*1e-8 && finitePositive(close.price) && average!==null && (t.direction==='long'||t.direction==='short') && c.confirmed && finitePositive(c.usdPerPriceUnit);
  const gross=valid ? money((t.direction==='short'?average!-close.price!:close.price!-average!)*q!*c.usdPerPriceUnit!) : null;
  const allocatedEntryFee=valid && entryCostKnown ? money(entryCost*q!/quantity) : null;
  const costs=allocatedEntryFee!==null && finiteNonnegative(close.fees) && (close.otherCosts==null||finiteNonnegative(close.otherCosts)) ? allocatedEntryFee+close.fees+(close.otherCosts??0) : null;
  const net=gross!==null && costs!==null ? money(gross-costs) : null;
  return {entryFeeEstimated,quantityBefore:quantity,average,gross,allocatedEntryFee,exitFee:finiteNonnegative(close.fees)?close.fees:null,estimatedExitFee:estimatedExecutionFee(c,q,close.price,'exit'),otherCosts:close.otherCosts??0,net,ready:net!==null,currency:c.currency??(instrumentOf(t)==='XAU'?'USD':'UNKNOWN')};
}

/** One projection for previews and summaries. Recorded broker net amounts remain authoritative. */
export function calculateTradePnl(t:TradeRecord,s:Settings){
  const currency=tradeContract(t,s).currency??(instrumentOf(t)==='XAU'?'USD':'UNKNOWN');
  const closes=orderedCloses(t).map(close=>{
    const result=closeCalculation(t,close,s),automatic=close.calculationMode==='automatic';
    return {...result,id:close.id,date:close.date,basis:automatic?'automatic' as const:'reported' as const,gross:automatic?result.gross:close.grossPnl??null,allocatedEntryFee:automatic?result.allocatedEntryFee:close.allocatedEntryFee??null,netPnl:automatic?result.net:Number.isFinite(close.netPnl)?close.netPnl:null};
  });
  const sumKnown=(values:(number|null|undefined)[])=>values.every((v):v is number=>v!=null&&Number.isFinite(v))?money(values.reduce((sum,v)=>sum+v,0)):null;
  const totalEntryFees=t.entries?.length?sumKnown(t.entries.map(e=>e.fees)):finiteNonnegative(t.aggregateEntryFee)?t.aggregateEntryFee:hasExecution(t)?null:0;
  const totalExitFees=sumKnown(t.closes.map(c=>c.fees)),allocatedEntryFees=sumKnown(closes.map(c=>c.allocatedEntryFee)),otherCosts=sumKnown(t.closes.map(c=>c.otherCosts??0));
  const incurredFees=totalEntryFees!==null&&totalExitFees!==null?money(totalEntryFees+totalExitFees):null;
  const totalFees=allocatedEntryFees!==null&&totalExitFees!==null?money(allocatedEntryFees+totalExitFees):null;
  const totalCosts=totalFees!==null&&otherCosts!==null?money(totalFees+otherCosts):null;
  const netPnl=isLegacySummary(t)?t.legacy!.netPnl:sumKnown(closes.map(c=>c.netPnl)),grossPnl=isLegacySummary(t)?null:sumKnown(closes.map(c=>c.gross));
  const riskCurrency=t.riskRuleSnapshot?.ruleCurrency;
  const netR=(t.status==='closed'||isLegacySummary(t))&&finitePositive(t.initialRisk)&&netPnl!==null&&(!riskCurrency||riskCurrency===currency)?netPnl/t.initialRisk:null;
  return {currency,closes,totalEntryFees,totalExitFees,incurredFees,allocatedEntryFees,totalFees,otherCosts,totalCosts,grossPnl,netPnl,netR,ready:netPnl!==null,feesEstimated:!!t.entries?.some(e=>e.feeSource==='estimated')||t.closes.some(c=>c.feeSource==='estimated'||c.costsEstimated)};
}

/** Recalculate explicitly automatic closes only; old reported net values remain exact. */
export function refreshAutomaticCloses(t:TradeRecord,s:Settings):TradeRecord {
  let next={...t,closes:t.closes.map(c=>({...c}))};
  for(const c of orderedCloses(next)) if(c.calculationMode==='automatic'){
    const p=closeCalculation(next,c,s);next={...next,closes:next.closes.map(e=>e.id===c.id?{...e,netPnl:p.net??null as unknown as number,grossPnl:p.gross,allocatedEntryFee:p.allocatedEntryFee,costsEstimated:p.entryFeeEstimated||c.feeSource==='estimated'}:e)};
  }
  return next;
}

export function dailyExecutionSummary(trades:TradeRecord[],date:string,s:Settings){
  // Legacy helper contains a quantity total: keep its original gold-only scope.
  // Multi-asset daily amounts are provided by multiAssetSummary.periods.day.
  const actual=trades.filter(t=>instrumentOf(t)==='XAU'&&!t.archived&&hasExecution(t)&&tradeCurrency(t)===(s.accountCurrency??'USD')),closes=actual.flatMap(t=>t.closes.filter(c=>c.date===date).map(c=>({trade:t,close:c}))),completed=actual.filter(t=>t.status==='closed'&&finalDate(t)===date);
  const entries=actual.flatMap(t=>(t.entries?.length?t.entries:t.openedDate===date&&t.quantity!==null?[{date:t.openedDate,quantity:t.quantity,fees:t.aggregateEntryFee??null,feeSource:'actual'}]:[]).filter(e=>e.date===date));
  const knownR=completed.filter(t=>t.initialRisk!==null&&t.initialRisk>0);
  const fees=[...entries.map(e=>e.feeSource==='estimated'?null:e.fees),...closes.map(e=>e.close.feeSource==='estimated'?null:e.close.fees)],knownFees=fees.filter((v):v is number=>v!==null);
  return {newTrades:actual.filter(t=>t.openedDate===date).length,entries:entries.length,partialCloses:closes.filter(({trade:t,close:c})=>t.status!=='closed'||orderedCloses(t).at(-1)?.id!==c.id).length,closedTrades:completed.length,net:closes.reduce((n,e)=>n+e.close.netPnl,0)+actual.filter(t=>isLegacySummary(t)&&t.legacy!.dailyDate===date).reduce((n,t)=>n+totalRealized(t),0),fees:knownFees.length?knownFees.reduce((n,v)=>n+v,0):null,feeCoverage:`${knownFees.length}/${fees.length}`,remaining:actual.reduce((n,t)=>n+(t.entries?.length?t.entries.filter(e=>e.date<=date).reduce((q,e)=>q+e.quantity,0):t.openedDate&&t.openedDate<=date?t.quantity??0:0)-t.closes.filter(c=>c.date<=date).reduce((q,c)=>q+(c.quantity??0),0),0),netR:knownR.length?knownR.reduce((n,t)=>n+totalRealized(t)/t.initialRisk!,0):null,knownR:knownR.length};
}

export function plannedAllocation(quantity:number|null,weights:number[],step:number|null){
  const sum=weights.reduce((n,w)=>n+w,0);if(!finitePositive(quantity)||sum<=0)return weights.map(()=>null);
  const raw=weights.map(w=>quantity*w/sum);
  if(step===null)return raw;
  const first=raw.slice(0,-1).map(q=>Math.floor((q+1e-10)/step)*step);
  return [...first,money(quantity-first.reduce((n,q)=>n+q,0))];
}

export function allocationRisk(t:TradeRecord,s:Settings){
  const c=tradeContract(t,s),plan=t.entryPlan;
  if(!plan?.length||!calculationContractReady(c)||!t.direction||plan.some(p=>p.quantity===null||p.price===null||p.stop===null||p.quantity<=0))return null;
  const distances=plan.map(p=>t.direction==='short'?p.stop!-p.price!:p.price!-p.stop!);if(distances.some(d=>d<=0))return null;
  const quantity=plan.reduce((n,p)=>n+p.quantity!,0),priceRisk=plan.reduce((n,p,i)=>n+distances[i]*p.quantity!*c.usdPerPriceUnit!,0),fees=plan.reduce((n,p)=>n+estimatedExecutionFee(c,p.quantity,p.price,'entry')!+estimatedExecutionFee(c,p.quantity,p.stop,'exit')!,0),slippage=quantity*c.slippagePrice!*c.usdPerPriceUnit!;
  return {quantity,priceRisk:money(priceRisk),fees:money(fees),slippage:money(slippage),totalRisk:money(priceRisk+fees+slippage),currency:c.currency??'USD'};
}
