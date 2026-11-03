'use client';
import React, { useRef } from 'react';
import type { Settings } from '../lib/domain';
import type { TradeRecord } from '../lib/trading';
import { INSTRUMENTS, INSTRUMENT_LABELS } from '../lib/multi-asset';
import type { Instrument } from '../lib/multi-asset';
import { tradeContract } from '../lib/calculations';
import { BufferedText } from './wellbeing-fields';
import { ContractFields } from './g1-fields';

type Change = (patch: Partial<TradeRecord>, render?: boolean) => void;

export function MultiAssetIdentityFields({trade, settings, selection, select, locked, change, read, commit, openSettings}: {
  trade: TradeRecord; settings: Settings; selection: Instrument | ''; select: (value: Instrument) => void;
  locked: boolean; change: Change; read: () => TradeRecord; commit: () => void; openSettings?: () => void;
}) {
  const contract = tradeContract(trade, settings),advanced=useRef<HTMLDetailsElement>(null);
  const configured=contract.confirmed&&contract.usdPerPriceUnit!==null&&contract.usdPerPriceUnit>0;
  const configure=()=>{if(openSettings){openSettings();return;}if(advanced.current){advanced.current.open=true;advanced.current.scrollIntoView?.({block:'nearest'});}};
  const symbol=trade.symbol&&trade.symbol!=='UNKNOWN'?trade.symbol:null;
  return <section className="form-section"><h3>交易品种</h3><div className="form-grid">
    <label className="form-field"><span className="field-label">交易品种 · 必选</span><select required aria-label="交易品种" value={selection} disabled={locked} onChange={event=>{if(event.target.value)select(event.target.value as Instrument);}}><option value="">请选择本笔交易品种</option>{INSTRUMENTS.map(instrument=><option key={instrument} value={instrument}>{INSTRUMENT_LABELS[instrument]} · {instrument}</option>)}</select></label>
    <div className="form-field"><span className="field-label">统一账户</span><strong>原黄金账户 · USD</strong><small>{symbol?`当前合约 ${symbol}`:'选择品种后自动载入合约配置'}</small></div>
  </div>
    {selection&&!configured&&<p className="muted-note">此品种的合约配置尚未完成；成交价格和实际费用仍可记录。{openSettings?<button type="button" className="icon-text" onClick={configure}>前往合约设置</button>:<a className="icon-text" href={'#contract-settings-'+selection} target="_blank" rel="noopener">设置合约一次</a>}</p>}
    <details className="form-section" ref={advanced}><summary>高级：合约参数与原始记录</summary>
      <p className="muted-note">日常只需录入数量、价格和实际手续费。合约参数在设置中维护，已成交记录保留自己的历史快照。</p>
      <fieldset className="editor-fieldset" disabled={locked||!selection}><div className="form-grid">
        <BufferedText label="实际合约代码" value={trade.symbol??''} maxLength={80} onDraft={symbol=>change({symbol},false)} onCommit={commit}/>
        <BufferedText label="报价来源" value={trade.quoteSource??''} maxLength={200} onDraft={quoteSource=>change({quoteSource},false)} onCommit={commit}/>
      </div><ContractFields value={contract} onChange={patch=>change({contract:{...tradeContract(read(),settings),...patch}})}/></fieldset>
      {locked&&<p className="muted-note">已成交合约快照保持原值；实际费用可在每次开平仓中更正。</p>}
      {trade.accountId&&trade.accountId!=='legacy'&&<p className="muted-note">原始账户标记：{trade.accountId}；统一账户归属由设置读取，不覆盖原始成交。</p>}
    </details>
  </section>;
}