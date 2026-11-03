import * as multiAsset from '../lib/multi-asset.ts';
import * as assetPolicy from '../lib/asset-policy.ts';
import * as calculations from '../lib/calculations.ts';
import * as g1Real from '../lib/g1.ts';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as domain from '../lib/domain.ts';
import * as repository from '../lib/repository.ts';
import * as tradesRepo from '../lib/trade-repository.ts';
import * as trading from '../lib/trading.ts';
import * as opportunities from '../lib/opportunities.ts';
import * as g1 from '../lib/g1.ts';
import * as imageFiles from '../lib/image-files.ts';
import * as vnext from '../lib/vnext.ts';
import * as vnextStats from '../lib/vnext-stats.ts';

export function apiHarness(){
  const sql=new DatabaseSync(':memory:');for(const name of readdirSync(new URL('../drizzle/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort())sql.exec(readFileSync(new URL('../drizzle/'+name,import.meta.url),'utf8'));
  const db={prepare(query){let values=[];const stmt=sql.prepare(query);return {bind(...args){values=args;return this;},async first(){return stmt.get(...values)??null;},async all(){return {success:true,results:stmt.all(...values)};},async run(){const m=stmt.run(...values);return {success:true,results:[],meta:{changes:Number(m.changes)}};}};},async batch(statements){sql.exec('BEGIN');try{const results=[];for(const stmt of statements)results.push(await stmt.all());sql.exec('COMMIT');return results;}catch(e){sql.exec('ROLLBACK');throw e;}}};
  const objects=new Map(),bucket={async put(key,bytes){objects.set(key,new Uint8Array(bytes));},async get(key){const b=objects.get(key);return b?{body:b}:null;},async delete(key){objects.delete(key);}};
  let user={userId:'A'};const cache=new Map();
  function load(file){if(cache.has(file))return cache.get(file);const source=readFileSync(new URL(file,import.meta.url),'utf8'),compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,module={exports:{}};
    runInNewContext(compiled,{exports:module.exports,Response,Request,URL,File,Uint8Array,crypto,Date,require(name){if(name.endsWith('multi-asset'))return multiAsset;if(name.endsWith('asset-policy'))return assetPolicy;if(name.endsWith('vnext-stats'))return vnextStats;if(name.endsWith('vnext'))return vnext;if(name.endsWith('calculations'))return calculations;if(name.endsWith('local-storage.mjs'))return {getLocalStorage:()=>({db,bucket})};if(name.endsWith('chatgpt-auth'))return {getChatGPTUser:async()=>user};if(name.endsWith('domain'))return domain;if(name.endsWith('repository')&&!name.endsWith('trade-repository'))return repository;if(name.endsWith('trade-repository'))return tradesRepo;if(name.endsWith('trading'))return trading;if(name.endsWith('opportunities'))return opportunities;if(name.endsWith('g1'))return g1;if(name.endsWith('image-files'))return imageFiles;if(name.endsWith('private-api'))return load('../app/api/private-api.ts');throw new Error(name);}});cache.set(file,module.exports);return module.exports;}
  const req=(path,method='GET',body,origin='https://private.test')=>new Request('https://private.test'+path,{method,headers:{...(method!=='GET'?{Origin:origin}:{}),...(body&&!(body instanceof FormData)?{'Content-Type':'application/json'}:{})},body:body?(body instanceof FormData?body:JSON.stringify(body)):undefined});
  return {opportunities:load('../app/api/opportunities/route.ts'),settings:load('../app/api/settings/route.ts'),drafts:load('../app/api/drafts/route.ts'),records:load('../app/api/records/route.ts'),trades:load('../app/api/trades/route.ts'),images:load('../app/api/images/route.ts'),history:load('../app/api/history/route.ts'),req,sql,db,bucket,objects,setUser(value){user=value;}};
}
