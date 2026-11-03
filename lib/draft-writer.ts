export type DraftStatus = 'idle' | 'editing' | 'saving' | 'saved' | 'error';

// One serialized write stream. A failed request retains the latest local draft.
export function createDraftWriter<T>(save: (value:T) => Promise<unknown>, onStatus:(status:DraftStatus, error?:string)=>void, delay=1100) {
  let pending:T | undefined, running:Promise<void> | null=null, timer:ReturnType<typeof setTimeout> | undefined, closed=false;
  let status:DraftStatus='idle';
  const notify=(next:DraftStatus,error?:string)=>{if(status!==next||error){status=next;onStatus(next,error);}};
  function enqueue(value:T){if(closed)return;pending=value;clearTimeout(timer);notify('editing');timer=setTimeout(()=>{void flush().catch(()=>{});},delay);}
  async function flush():Promise<void>{
    clearTimeout(timer);
    if(running){await running;if(pending&&!closed)await flush();return;}
    if(pending===undefined||closed)return;
    const drain=async()=>{
      while(pending!==undefined&&!closed){
        const value=pending;pending=undefined;notify('saving');
        try{await save(value);}catch(e){if(pending===undefined)pending=value;notify('error',e instanceof Error?e.message:'草稿保存失败');throw e;}
      }
      if(!closed)notify('saved');
    };
    running=drain();
    try{await running;}finally{running=null;}
  }
  return {enqueue,flush,hasPending:()=>pending!==undefined||running!==null,close(){closed=true;clearTimeout(timer);}};
}
