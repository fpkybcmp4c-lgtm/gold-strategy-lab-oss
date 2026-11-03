import type {Settings} from './domain.ts';
import type {TradeRecord} from './trading.ts';
import {instrumentConfig,instrumentOf,unifiedAccountConfig} from './multi-asset.ts';
import {vnextRiskAssessment,currentEffectiveRules,vnextFramework} from './vnext.ts';
export type AssetRuleSnapshot={instrument:'NQ'|'BTC';currency:string;normalRisk:number|null;riskLimit:number|null;capturedAt:string;version:string};
export function savedAssetRules(t:TradeRecord){return t.instrumentRiskSnapshot as AssetRuleSnapshot|undefined;}
export function captureAssetRules(t:TradeRecord,s:Settings):AssetRuleSnapshot{const instrument=instrumentOf(t) as 'NQ'|'BTC',c=instrumentConfig(s,instrument),unified=unifiedAccountConfig(s),rules=currentEffectiveRules(s),framework=vnextFramework(t),band=framework==='pending'?null:framework==='G1'?rules.G1:rules.independent;return {instrument,currency:unified?.currency??c.contract.currency??'UNKNOWN',normalRisk:unified?band?.normalMax??null:c.normalRisk,riskLimit:unified?band?.hardLimit??null:c.riskLimit,capturedAt:new Date().toISOString(),version:unified?'unified-account-1':'multi-asset-1'};}
/** Compatibility export; every instrument now uses the same saved framework engine. */
export function independentRiskAssessment(t:TradeRecord,s:Settings){return vnextRiskAssessment(t,s);}
