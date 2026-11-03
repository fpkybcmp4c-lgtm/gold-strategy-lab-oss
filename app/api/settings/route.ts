import { DEFAULT_SETTINGS, settingsSchema } from '../../../lib/domain';
import { loadData } from '../../../lib/repository';
import { fieldChanges } from '../../../lib/trading';
import { RecordError } from '../../../lib/trade-repository';
import { apiError, privateContext, privateJSON } from '../private-api';
import { currentEffectiveRules } from '../../../lib/vnext';
export async function PUT(request:Request){try{
  const {user,db}=await privateContext(request),raw=await request.json(),incoming=(raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:{}),before=(await loadData(db,user.userId)).settings,parsed=settingsSchema.safeParse({...before,...incoming});
  if(!parsed.success)throw new RecordError(parsed.error.issues[0].message);
  const now=new Date().toISOString();
  if(parsed.data.g1&&JSON.stringify(before?.g1)!==JSON.stringify(parsed.data.g1))parsed.data.g1={...parsed.data.g1,ruleVersion:(before?.g1?.ruleVersion??0)+1,effectiveAt:now};
  if(parsed.data.riskRules){
    const previous=currentEffectiveRules(before??DEFAULT_SETTINGS),next=parsed.data.riskRules;
    const changed=(['G1','independent'] as const).filter(key=>JSON.stringify({...previous[key],effectiveAt:null})!==JSON.stringify({...next[key],effectiveAt:null}));
    parsed.data.riskRules={...next,version:changed.length?'VNext-'+now:previous.version,effectiveAt:changed.length?now:previous.effectiveAt,G1:{...next.G1,effectiveAt:changed.includes('G1')?now:previous.G1.effectiveAt},independent:{...next.independent,effectiveAt:changed.includes('independent')?now:previous.independent.effectiveAt}};
  }
  await db.batch([
    db.prepare('INSERT OR IGNORE INTO source_backups (owner_id, source_key, data, created_at) VALUES (?, ?, ?, ?)').bind(user.userId,'settings',JSON.stringify(before),now),
    db.prepare('INSERT INTO user_settings (owner_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(owner_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at').bind(user.userId,JSON.stringify(parsed.data),now),
    db.prepare('INSERT INTO record_history (owner_id, id, entity_type, entity_id, data, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(user.userId,crypto.randomUUID(),'settings','config',JSON.stringify(fieldChanges(before,parsed.data)),now),
  ]);return privateJSON({ok:true,settings:parsed.data});
}catch(e){return apiError(e);}}
