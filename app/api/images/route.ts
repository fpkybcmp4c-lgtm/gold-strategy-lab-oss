import { loadData } from '../../../lib/repository';
import { calendarDate, imageMetaSchema } from '../../../lib/trading';
import type { TradeImage } from '../../../lib/trading';
import { allTrades, deleteImageMetadata, imageRow, imagesFor, putImageMetadata, RecordError } from '../../../lib/trade-repository';
import { MAX_IMAGE_BYTES, verifiedImage } from '../../../lib/image-files';
import { apiError, privateContext, privateJSON } from '../private-api';
export const dynamic='force-dynamic';
export async function GET(request:Request){try{
  const {user,db,bucket}=await privateContext(),q=new URL(request.url).searchParams,id=q.get('id');
  if(!id)return privateJSON({images:await imagesFor(db,user.userId,q.get('tradeId')??undefined)});
  const row=await imageRow(db,user.userId,id);if(!row)throw new RecordError('截图不存在。',404);
  if(!bucket)throw new RecordError('私密图片存储暂时不可用。',503);
  const object=await bucket.get(row.object_key);if(!object)throw new RecordError('图片文件暂未找到，请重试。',404);
  const meta:TradeImage=JSON.parse(row.data);
  return new Response(object.body,{headers:{'Content-Type':meta.mime,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin','Content-Disposition':q.get('download')==='1'?'attachment; filename="kline.'+meta.mime.split('/')[1]+'"':'inline'}});
}catch(e){return apiError(e);}}
async function upload(request:Request,replacing=false){try{
  const {user,db,bucket}=await privateContext(request);if(!bucket)throw new RecordError('私密图片存储尚未就绪，请稍后重试。',503);
  const length=Number(request.headers.get('content-length'));if(length>MAX_IMAGE_BYTES+100000)throw new RecordError('每张截图需在 8 MB 以内。',413);
  const form=await request.formData(),file=form.get('file');if(!(file instanceof File))throw new RecordError('请选择一张截图。');if(file.size>MAX_IMAGE_BYTES)throw new RecordError('每张截图需在 8 MB 以内。',413);
  const parsed=imageMetaSchema.safeParse({timeframe:form.get('timeframe')??'1小时',stage:form.get('stage')??'开仓前分析',caption:form.get('caption')??''});if(!parsed.success)throw new RecordError('截图类型或备注无效。');
  const requestedId=new URL(request.url).searchParams.get('id'),oldRow=replacing&&requestedId?await imageRow(db,user.userId,requestedId):null;
  if(replacing&&!oldRow)throw new RecordError('截图不存在。',404);
  const before:TradeImage|undefined=oldRow?JSON.parse(oldRow.data):undefined;
  const entityType=before?(before.entityType??'trade'):(form.get('entityType')==='daily'?'daily':form.get('entityType')==='opportunity'?'opportunity':'trade'),dailyDate=before?.dailyDate??String(form.get('dailyDate')??''),opportunityId=before?.opportunityId??String(form.get('opportunityId')??''),tradeId=entityType==='daily'?'daily:'+dailyDate:entityType==='opportunity'?'opportunity:'+opportunityId:before?.tradeId??String(form.get('tradeId')??'');
  if(entityType==='daily'){if(!calendarDate.safeParse(dailyDate).success)throw new RecordError('每日截图日期无效。');const saved=await db.prepare('SELECT date FROM daily_records WHERE owner_id = ? AND date = ? UNION SELECT date FROM daily_drafts WHERE owner_id = ? AND date = ?').bind(user.userId,dailyDate,user.userId,dailyDate).first();if(!saved)throw new RecordError('请先保存这一天的观察或草稿，再上传截图。',404);}
  else if(entityType==='opportunity'){if(!opportunityId||opportunityId.length>200)throw new RecordError('机会ID无效。');const saved=await db.prepare('SELECT id FROM opportunity_records WHERE owner_id = ? AND id = ?').bind(user.userId,opportunityId).first();if(!saved)throw new RecordError('请先保存当前账号的机会记录，再上传截图。',404);}
  else{const data=await loadData(db,user.userId);if(!(await allTrades(db,user.userId,data.records)).some(t=>t.id===tradeId))throw new RecordError('请先保存这笔交易，再上传截图。',404);}
  const bytes=await file.arrayBuffer();let format;try{format=verifiedImage(new Uint8Array(bytes),file.name,file.type);}catch(e){throw new RecordError((e as Error).message);}
  const now=new Date().toISOString(),id=before?.id??crypto.randomUUID(),key='screenshots/'+encodeURIComponent(user.userId)+'/'+encodeURIComponent(tradeId)+'/'+crypto.randomUUID()+'.'+format.ext;
  const image:TradeImage={...parsed.data,id,tradeId,entityType,...(entityType==='daily'?{dailyDate}:entityType==='opportunity'?{opportunityId}:{}),fileName:file.name.slice(0,200),mime:format.mime,size:file.size,createdAt:before?.createdAt??now,updatedAt:now};
  await bucket.put(key,bytes,{httpMetadata:{contentType:format.mime}});
  try{await putImageMetadata(db,user.userId,image,key,before);}catch(e){await bucket.delete(key).catch(()=>{});throw e;}
  if(oldRow)await bucket.delete(oldRow.object_key).catch(()=>{});
  return privateJSON({ok:true,image});
}catch(e){return apiError(e);}}
export async function POST(request:Request){return upload(request);}
export async function PUT(request:Request){return upload(request,true);}
export async function PATCH(request:Request){try{
  const {user,db}=await privateContext(request),id=new URL(request.url).searchParams.get('id')??'',row=await imageRow(db,user.userId,id);if(!row)throw new RecordError('截图不存在。',404);
  const result=imageMetaSchema.safeParse(await request.json());if(!result.success)throw new RecordError('截图备注或类型无效。');
  const before:TradeImage=JSON.parse(row.data),image={...before,...result.data,updatedAt:new Date().toISOString()};await putImageMetadata(db,user.userId,image,row.object_key,before);return privateJSON({ok:true,image});
}catch(e){return apiError(e);}}
export async function DELETE(request:Request){try{
  const {user,db,bucket}=await privateContext(request),row=await imageRow(db,user.userId,new URL(request.url).searchParams.get('id')??'');if(!row)throw new RecordError('截图不存在。',404);
  await deleteImageMetadata(db,user.userId,JSON.parse(row.data));if(bucket)await bucket.delete(row.object_key);return privateJSON({ok:true});
}catch(e){return apiError(e);}}
