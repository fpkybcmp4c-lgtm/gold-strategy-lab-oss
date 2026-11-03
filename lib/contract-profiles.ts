import type { ContractConfig } from './g1-schema.ts';
import type { Instrument } from './multi-asset-schema.ts';

export const normalizeContractCode=(symbol:string|undefined)=>symbol?.trim().toUpperCase().replace(/^.*:/,'').replace(/\.(P|PERP)$/,'')??'';
export const defaultProfileSymbol=(instrument:Instrument)=>({XAU:'XAUUSDT.P',NQ:'QQQUSDT.P',BTC:'BTCUSDT.P'})[instrument];

// Exact product mappings, expressed in base-asset quantities. A futures lot (NQ/MNQ)
// is deliberately a different profile. Never infer a multiplier from the asset tab.
// Sources: Binance USD-M PnL FAQ 3a55a23768cb416fb404f06ffedde4b2;
// QQQ TradFi specifications /about-legal/contractspecs-usdmperpetualqqq;
// CME Micro E-mini Nasdaq-100 rule 361 and E-mini Nasdaq-100 rule 359.
export function knownContractProfile(symbol:string|undefined):ContractConfig|null{
  const code=normalizeContractCode(symbol),multipliers:Record<string,number>={QQQUSDT:1,BTCUSDT:1,MNQ:2,NQ:20};
  const multiplier=multipliers[code];if(multiplier===undefined)return null;
  return {confirmed:true,usdPerPriceUnit:multiplier,currency:'USD',settlement:'linear',feeMode:'perQuantity',entryFeePerQty:null,exitFeePerQty:null,slippagePrice:null,quantityStep:null};
}
