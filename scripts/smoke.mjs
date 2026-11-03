import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_SETTINGS, blankDay } from '../lib/domain.ts';
import { blankTrade } from '../lib/trading.ts';

// Real production HTTP acceptance; requires an existing `pnpm build` result.
const temporary = mkdtempSync(path.join(tmpdir(), 'strategy-lab-http-'));
const directory = path.join(temporary, 'data');
const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe,'listening');
const port = probe.address().port; await new Promise(resolve=>probe.close(resolve));
const base = 'http://127.0.0.1:' + port;
let child, output = '';
async function start() {
  output = '';
  child = spawn(process.execPath,['scripts/start.mjs'],{cwd: process.cwd(), env:{...process.env,PORT:String(port),DATA_DIR:directory,NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
  child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  for(let i=0;i<100;i++) {
    if(child.exitCode!==null)throw new Error('启动失败：'+output);
    try { const r=await fetch(base+'/api/records'); if(r.status===200)return; } catch {}
    await delay(200);
  }
  throw new Error('启动超时：'+output);
}
async function stop() {
  if(!child||child.exitCode!==null)return;
  const ended=once(child,'exit');child.send('stop');
  const result=await Promise.race([ended,delay(15000,undefined,{ref:false}).then(()=>null)]);
  if(result===null){child.kill();await ended;throw new Error('服务未能正常停止：'+output);}
  assert.equal(result[0],0,output);
}
async function api(endpoint,method='GET',body) {
  const response=await fetch(base+'/api/'+endpoint,{method,headers:{Origin:base,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;
}
try {
  await start();
  assert.equal((await api('records')).records.length,0);
  await api('settings','PUT',{...DEFAULT_SETTINGS,capital:12345});
  const date='2030-01-01';await api('records','PUT',{...blankDay(date),note:'Demo HTTP acceptance'});
  let trade=(await api('trades','PUT',{...blankTrade(date),instrument:'XAU',direction:'short',model:'S1',entryPrice:2500,quantity:1,initialRisk:100,rationale:'Demo only'})).trade;
  trade=(await api('trades','PUT',{...trade,pattern:'Demo edit'})).trade;assert.equal(trade.pattern,'Demo edit');
  const response=await fetch(base+'/api/records',{headers:{Origin:'http://invalid.example'}});assert.equal(response.status,403);
  const spoofed=await new Promise((resolve,reject)=>http.get(base+'/api/records',{headers:{Host:'invalid.example:'+port}},r=>{r.resume();r.on('end',()=>resolve(r.statusCode));}).on('error',reject));assert.equal(spoofed,403);
  trade=(await api('trades','PATCH',{id:trade.id,revision:trade.revision,action:'trash'})).trade;assert.equal(trade.archived,true);
  await stop();assert.equal(existsSync(directory+'.lock'),false);
  await start();const data=await api('records');assert.equal(data.settings.capital,12345);assert.equal(data.records[0].note,'Demo HTTP acceptance');assert.equal(data.trades[0].archived,true);
  trade=(await api('trades','PATCH',{id:trade.id,revision:trade.revision,action:'restore'})).trade;assert.equal(trade.archived,false);
  await api('records?date='+date,'DELETE');assert.equal((await api('records')).records.length,0);
  await stop();
  console.log('生产HTTP验收通过：空库、设置、每日记录、交易新增/编辑/回收/恢复、跨源及Host拒绝、停机锁释放、重启持久化。');
} finally {
  if(child&&child.exitCode===null)await stop();
  const target=path.resolve(temporary);
  assert.ok(target.startsWith(path.resolve(tmpdir())+path.sep)&&path.basename(target).startsWith('strategy-lab-http-'));
  rmSync(target,{recursive:true,force:true});
}
