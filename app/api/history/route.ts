import { historyFor } from '../../../lib/trade-repository';
import { apiError, privateContext, privateJSON } from '../private-api';
export const dynamic='force-dynamic';
export async function GET(request:Request){try{const {user,db}=await privateContext(),params=new URL(request.url).searchParams;return privateJSON({history:await historyFor(db,user.userId,params.get('type')??'daily',params.get('id')??'')});}catch(e){return apiError(e);}}
