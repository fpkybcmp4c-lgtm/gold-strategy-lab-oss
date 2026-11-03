import { getLocalStorage } from '../../lib/local-storage.mjs';
import { getChatGPTUser } from '../chatgpt-auth';
import { RecordError } from '../../lib/trade-repository';
export const privateJSON=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'private, no-store'}});
export async function privateContext(request?:Request){
  const user=await getChatGPTUser();if(!user)throw new RecordError('请登录后访问私人记录。',401);
  // Next can normalize its internal URL; the loopback HTTP entry validates Host.
  const origin=request?(request.headers.get('host')?'http://'+request.headers.get('host'):new URL(request.url).origin):null;
  if(request&&request.method!=='GET'&&request.headers.get('origin')!==origin)throw new RecordError('请求来源无效。',403);
  const {db,bucket}=getLocalStorage();
  return {user,db,bucket};
}
export function apiError(error:unknown){return privateJSON({error:error instanceof RecordError?error.message:'操作暂未完成，请保留填写并重试。'},error instanceof RecordError?error.status:503);}
