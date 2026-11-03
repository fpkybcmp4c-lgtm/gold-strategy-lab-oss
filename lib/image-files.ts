export const MAX_IMAGE_BYTES=8*1024*1024;
export function verifiedImage(bytes:Uint8Array,name:string,type:string){
  if(!bytes.length||bytes.length>MAX_IMAGE_BYTES)throw new Error('每张截图需在 8 MB 以内。');
  const ext=name.toLowerCase().split('.').at(-1),same=(a:number[])=>a.every((v,i)=>bytes[i]===v);
  const png=same([137,80,78,71,13,10,26,10]),jpg=same([255,216,255]);
  const webp=String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP';
  const mime=png?'image/png':jpg?'image/jpeg':webp?'image/webp':null;
  if(!mime||!['png','jpg','jpeg','webp'].includes(ext??'')||type&&type!==mime)throw new Error('仅支持内容有效的 PNG、JPG、JPEG 或 WebP 截图。');
  if(png&&ext!=='png'||jpg&&!['jpg','jpeg'].includes(ext??'')||webp&&ext!=='webp')throw new Error('图片格式与文件扩展名不一致。');
  return {mime,ext:png?'png':jpg?'jpg':'webp'};
}
