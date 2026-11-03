import { getLocalStorage } from '../../../lib/local-storage.mjs';
import { getChatGPTUser } from '../../chatgpt-auth';
import { dailyDraftSchema } from '../../../lib/domain';
import { deleteDraft, loadDraft, saveDraft } from '../../../lib/repository';
export const dynamic='force-dynamic';
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
async function identity(request:Request){
  const user=await getChatGPTUser();
  if(!user)return {error:json({error:'请登录后访问私人草稿。'},401)};
  const origin=request.headers.get('host')?'http://'+request.headers.get('host'):new URL(request.url).origin;
  if(request.method!=='GET' && request.headers.get('origin')!==origin)return {error:json({error:'请求来源无效。'},403)};
  return {user,db:getLocalStorage().db};
}
function dateOf(request:Request){const d=new URL(request.url).searchParams.get('date');return d&&/^\d{4}-\d{2}-\d{2}$/.test(d)?d:null;}
export async function GET(request:Request){try{const auth=await identity(request);if(auth.error)return auth.error;const date=dateOf(request);if(!date)return json({error:'日期无效'},400);return json({draft:await loadDraft(auth.db!,auth.user!.userId,date)});}catch{return json({error:'无法恢复草稿，确认后的历史记录仍然保留。'},503);}}
export async function PUT(request:Request){try{const auth=await identity(request);if(auth.error)return auth.error;const result=dailyDraftSchema.safeParse(await request.json());if(!result.success)return json({error:result.error.issues[0].message},400);await saveDraft(auth.db!,auth.user!.userId,result.data);return json({ok:true});}catch{return json({error:'草稿尚未保存，请保留页面并重试。'},503);}}
export async function DELETE(request:Request){try{const auth=await identity(request);if(auth.error)return auth.error;const date=dateOf(request);if(!date)return json({error:'日期无效'},400);await deleteDraft(auth.db!,auth.user!.userId,date);return json({ok:true});}catch{return json({error:'未能丢弃草稿，请重试。'},503);}}
