import { DEFAULT_SETTINGS as applicationDefaults } from '../lib/domain.ts';
import { DEFAULT_VNEXT_RISK_RULES as applicationRiskDefaults } from '../lib/vnext-schema.ts';

// Demo only. Explicit fictional dates/balance keep regression tests independent
// of a new installation's defaults. No account data or adoption time is imported.
export const DEMO_RISK_RULES = {
  ...structuredClone(applicationRiskDefaults), effectiveAt: '2026-10-13T05:00:00Z',
  independent: { ...applicationRiskDefaults.independent, effectiveAt: '2026-10-13T05:00:00Z' },
};
export const DEMO_SETTINGS = {
  ...applicationDefaults, start: '2026-10-10', end: '2027-01-09', capital: 20000,
  riskRules: DEMO_RISK_RULES,
};
