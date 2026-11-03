'use client';

import React, { useId, useRef, useState } from 'react';
import { Copy, Download, X } from 'lucide-react';
import { todayCN } from '../lib/domain';

type ReviewScope = 'today' | 'positions' | 'week' | 'range';
type ReviewPayload = Record<string, unknown>;

function sevenDaysStart() {
  const date = new Date(`${todayCN()}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 6);
  return date.toISOString().slice(0, 10);
}

function metadata(value: unknown, fallback: string): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return fallback;
}

function sourceName(value: unknown): string {
  if (value && typeof value === 'object' && 'name' in value && typeof value.name === 'string') return value.name;
  return metadata(value, '本网站 /api/review');
}

function shortVersion(value: string): string {
  return value.length > 40 ? `${value.slice(0, 16)}…${value.slice(-12)}` : value;
}

function apiError(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'message' in value && typeof value.message === 'string') return value.message;
  return '复盘接口未能返回数据。';
}

export function ReviewExport() {
  const dialog = useRef<HTMLDialogElement>(null);
  const textArea = useRef<HTMLTextAreaElement>(null);
  const requestRunning = useRef(false);
  const id = useId();
  const [scope, setScope] = useState<ReviewScope>('today');
  const [start, setStart] = useState(sevenDaysStart);
  const [end, setEnd] = useState(todayCN);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [payload, setPayload] = useState<ReviewPayload | null>(null);
  const [manualText, setManualText] = useState('');

  function clearResult() {
    setError('');
    setStatus('');
    setPayload(null);
    setManualText('');
  }

  async function exportReview(action: 'copy' | 'download') {
    if (requestRunning.current) return;
    clearResult();
    if (scope === 'range' && (!start || !end || start > end)) {
      setError('请选择有效的起止日期，开始日期不能晚于结束日期。');
      return;
    }
    requestRunning.current = true;
    setBusy(true);
    try {
      const params = new URLSearchParams({ scope: scope === 'week' ? 'range' : scope });
      if (scope === 'week' || scope === 'range') {
        params.set('start', scope === 'week' ? sevenDaysStart() : start);
        params.set('end', scope === 'week' ? todayCN() : end);
      }
      const response = await fetch(`/api/review?${params}`, {
        method: 'GET', credentials: 'same-origin', cache: 'no-store',
      });
      let result: unknown;
      try {
        result = await response.json();
      } catch {
        throw new Error(`复盘读取失败：接口没有返回有效 JSON（HTTP ${response.status}）。`);
      }
      const object = result && typeof result === 'object' && !Array.isArray(result) ? result as ReviewPayload : null;
      const resultError = object?.error;
      if (!response.ok || (resultError !== undefined && resultError !== null && resultError !== false && resultError !== '')) {
        throw new Error(`复盘读取失败（HTTP ${response.status}）：${apiError(resultError)}`);
      }
      if (!object) throw new Error('复盘读取失败：接口返回的数据格式不正确。');
      const json = JSON.stringify(object, null, 2);
      setPayload(object);
      if (action === 'download') {
        const url = URL.createObjectURL(new Blob([json], { type: 'application/json;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `gold-review-${scope}-${todayCN()}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        setStatus('已读取接口最新数据，并发起 JSON 下载。');
      } else {
        try {
          if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
          await navigator.clipboard.writeText(json);
          setStatus('已复制本次接口返回的完整复盘 JSON，可粘贴到 ChatGPT。');
        } catch {
          setManualText(json);
          setStatus('已读取接口最新数据，但浏览器未允许自动复制。请选中下方文本后手动复制，或下载 JSON。');
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '复盘读取失败，请稍后重试。');
    } finally {
      requestRunning.current = false;
      setBusy(false);
    }
  }

  return <>
    <button type="button" className="button secondary" aria-haspopup="dialog" onClick={() => dialog.current?.showModal()}><Copy size={14}/>复盘数据</button>
    <dialog ref={dialog} className="modal review-export-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} style={{ width: 500, maxWidth: 'calc(100vw - 24px)', padding: 0 }}>
      <div className="modal-header"><h2 id={`${id}-title`}>复制最新复盘数据</h2><button type="button" className="icon-button" aria-label="关闭复盘导出" onClick={() => dialog.current?.close()}><X size={16}/></button></div>
      <div className="info-content" style={{ maxHeight: 'calc(94dvh - 150px)', overflowY: 'auto' }}>
        <p id={`${id}-description`}>每次复制或下载都会重新读取网站保存的数据。今天与日期范围均按北京时间；这里只读取，不修改记录。</p>
        <label className="form-field"><span className="field-label">复盘范围</span><select value={scope} disabled={busy} onChange={event => { setScope(event.target.value as ReviewScope); clearResult(); }}><option value="today">今日复盘 · 默认</option><option value="positions">当前持仓</option><option value="week">最近 7 天 · 含今天</option><option value="range">指定起止日期</option></select></label>
        {scope === 'range' && <div className="form-grid" style={{ marginTop: 12 }}><label className="form-field"><span className="field-label">开始日期</span><input type="date" value={start} disabled={busy} onChange={event => { setStart(event.target.value); clearResult(); }}/></label><label className="form-field"><span className="field-label">结束日期</span><input type="date" value={end} disabled={busy} onChange={event => { setEnd(event.target.value); clearResult(); }}/></label></div>}
        <p>导出包含网站保存的记录，不代表交易所实时持仓或实时行情。</p>
        {busy && <p role="status">正在读取最新复盘数据…</p>}
        {error && <div className="error-banner" role="alert">{error}</div>}
        {status && <p role="status">{status}</p>}
        {payload && <div className="compact-empty" style={{ padding: '10px 0', overflowWrap: 'anywhere' }}>来源：{sourceName(payload.source)}<br/>生成时间：{metadata(payload.generatedAt, '接口未提供')}<br/>数据版本：<span title={metadata(payload.dataVersion, '接口未提供')}>{shortVersion(metadata(payload.dataVersion, '接口未提供'))}</span></div>}
        {manualText && <div className="form-field"><label className="field-label" htmlFor={`${id}-json`}>本次读取的完整 JSON · 只读</label><textarea id={`${id}-json`} ref={textArea} readOnly value={manualText} rows={10} spellCheck={false} style={{ fontFamily: 'monospace', fontSize: 11 }}/><button type="button" className="icon-text" onClick={() => { textArea.current?.focus(); textArea.current?.select(); }}>选中全部文本</button><span className="field-label">选中后按 Ctrl+C（Mac 为 ⌘C），或使用浏览器的复制菜单。</span></div>}
      </div>
      <div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => void exportReview('download')}><Download size={14}/>下载 JSON</button><button type="button" className="button primary" disabled={busy} onClick={() => void exportReview('copy')}><Copy size={14}/>{busy ? '读取中…' : '读取并复制'}</button></div>
    </dialog>
    <style>{'.review-export-dialog::backdrop{background:#182d2470;backdrop-filter:blur(3px)}'}</style>
  </>;
}
