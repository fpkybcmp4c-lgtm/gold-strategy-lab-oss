import { g1Side } from '../../../lib/trading';
import { loadOpportunities, opportunitySchema, saveOpportunity } from '../../../lib/opportunities';
import { loadData } from '../../../lib/repository';
import { allTrades, RecordError } from '../../../lib/trade-repository';
import { apiError, privateContext, privateJSON } from '../private-api';
export const dynamic='force-dynamic';
export async function GET(){try{const {user,db}=await privateContext();return privateJSON({opportunities:await loadOpportunities(db,user.userId)});}catch(e){return apiError(e);}}
export async function PUT(request:Request){try{const {user,db}=await privateContext(request),parsed=opportunitySchema.safeParse(await request.json());if(!parsed.success)throw new RecordError(parsed.error.issues[0].message);if(parsed.data.tradeId){const {records}=await loadData(db,user.userId),trades=await allTrades(db,user.userId,records);if(!trades.some(t=>t.id===parsed.data.tradeId&&g1Side(t)!==null&&t.direction===g1Side(t)&&t.direction===(parsed.data.plan.side??'short')&&!t.archived))throw new RecordError('请关联当前账号已保存且方向一致的G1交易。');const existing=await loadOpportunities(db,user.userId);if(existing.some(o=>o.id!==parsed.data.id&&o.tradeId===parsed.data.tradeId))throw new RecordError('这笔交易已关联另一条机会，不能重复计数。');}return privateJSON({ok:true,opportunity:await saveOpportunity(db,user.userId,parsed.data)});}catch(e){return apiError(e);}}
