import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function harness(){
  const slots=[],effects=[],timers=new Map();let cursor=0,now=0,nextTimer=1,parentDraft='',parentCommits=0;
  const react={createElement(type,props,...children){return {type,props:{...props,children}};},useState(initial){const i=cursor++;slots[i]??={value:initial};return [slots[i].value,v=>{slots[i].value=typeof v==='function'?v(slots[i].value):v;}];},useRef(initial){const i=cursor++;return slots[i]??={current:initial};},useEffect(fn,deps){const i=cursor++,old=slots[i];if(!old||deps.some((v,j)=>!Object.is(v,old.deps?.[j]))){effects.push(()=>{old?.cleanup?.();slots[i]={deps,cleanup:fn()};});}}};
  const module={exports:{}},source=readFileSync(new URL('../app/wellbeing-fields.tsx',import.meta.url),'utf8');
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
  runInNewContext(compiled,{exports:module.exports,require(name){if(name==='react')return react;if(name==='lucide-react')return {};if(name.endsWith('wellbeing'))return {};throw new Error(name);},setTimeout(fn,ms){const id=nextTimer++;timers.set(id,{fn,at:now+ms});return id;},clearTimeout(id){timers.delete(id);}});
  let propValue='';
  function render(){cursor=0;const element=module.exports.BufferedText({label:'复盘',value:propValue,rows:4,onDraft:v=>{parentDraft=v;},onCommit:()=>{propValue=parentDraft;parentCommits++;}});while(effects.length)effects.shift()();return element.props.children.find(c=>c.type==='textarea').props;}
  function tick(ms){now+=ms;for(const [id,timer] of [...timers])if(timer.at<=now){timers.delete(id);timer.fn();}}
  return {render,tick,get draft(){return parentDraft;},get commits(){return parentCommits;},get value(){return propValue;}};
}
test('long Chinese composition stays local without parent renders or per-key commits; pause synchronizes latest text',()=>{
  const h=harness();let input=h.render();input.onCompositionStart();
  for(const text of ['z','zh','中文','中文连续输入'.repeat(300)]){input=h.render();input.onChange({target:{value:text}});h.tick(600);assert.equal(h.commits,0);}
  input=h.render();assert.equal(input.value,h.draft);input.onCompositionEnd();h.tick(499);assert.equal(h.commits,0);h.tick(1);assert.equal(h.commits,1);assert.equal(h.value,'中文连续输入'.repeat(300));
});
test('blur flushes the final character immediately and cancels a second delayed commit',()=>{
  const h=harness();let input=h.render();input.onChange({target:{value:'第一段\n最后一个字。'}});input=h.render();input.onBlur();assert.equal(h.value,'第一段\n最后一个字。');assert.equal(h.commits,1);h.tick(1000);assert.equal(h.commits,1);
});
