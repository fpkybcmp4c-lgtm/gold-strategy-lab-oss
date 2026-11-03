'use client';
import React from 'react';
import type { Settings } from '../lib/domain';
import type { CloseEvent, TradeRecord } from '../lib/trading';
import { blankG1, blankPsychology } from '../lib/g1-schema';
import { blankEntrySnapshot, STRUCTURE_OPTIONS, REGIME_OPTIONS, VOLATILITY_OPTIONS, ENTRY_APPROACH_OPTIONS, LOCATION_OPTIONS, SETUP_STAGE_OPTIONS, TRIGGER_OPTIONS, CONFIRMATION_OPTIONS, INVALIDATION_OPTIONS, EMOTION_OPTIONS, EXTERNAL_OPINION_OPTIONS, DISCIPLINE_OPTIONS, DEVIATION_OPTIONS, CLOSE_REASON_OPTIONS } from '../lib/vnext-schema';
import type { EntrySnapshot } from '../lib/vnext-schema';
import { vnextFramework, vnextRiskAssessment } from '../lib/vnext';
import { Num } from './form-fields';
import { BufferedText } from './wellbeing-fields';

type Options = readonly (readonly [string, string])[];
type Change = (patch: Partial<TradeRecord>, render?: boolean) => void;

function Choices({ label, value, options, change, large = false }: { label: string; value: string | null | undefined; options: Options; change: (value: string) => void; large?: boolean }) {
  return <div className="form-field"><span className="field-label">{label}</span><div role="group" aria-label={label} className={large ? undefined : 'segmented'} style={{ display: 'flex', flexWrap: 'wrap', gap: 5, width: '100%', whiteSpace: 'normal' }}>{options.map(([code, name]) => <button type="button" key={code} aria-pressed={value === code} className={large ? 'button secondary' : value === code ? 'selected' : ''} style={{ whiteSpace: 'normal', ...(large ? { flex: 1, background: value === code ? 'var(--selected)' : undefined } : {}) }} onClick={() => change(code)}>{name}</button>)}</div></div>;
}

function MultiChoices({ label, values, options, change }: { label: string; values: string[]; options: Options; change: (values: string[]) => void }) {
  return <div className="form-field"><span className="field-label">{label} · 可多选</span><div role="group" aria-label={label} className="segmented" style={{ display: 'flex', flexWrap: 'wrap', gap: 5, width: '100%', whiteSpace: 'normal' }}>{options.map(([code, name]) => <button type="button" key={code} aria-pressed={values.includes(code)} className={values.includes(code) ? 'selected' : ''} style={{ whiteSpace: 'normal' }} onClick={() => change(values.includes(code) ? values.filter(value => value !== code) : [...values, code])}>{name}</button>)}</div></div>;
}

export function QuickClassification({ trade, settings, change }: { trade: TradeRecord; settings: Settings; change: Change }) {
  const framework = vnextFramework(trade);
  const snapshot = trade.entrySnapshot ?? blankEntrySnapshot();
  const modelOptions: Options = trade.direction === 'long' ? [['L1', 'L1 需求区支撑'], ['L2', 'L2 阻力突破回测'], ['S1', 'S1 供给区受阻'], ['S2', 'S2 支撑跌破回测']] : [['S1', 'S1 供给区受阻'], ['S2', 'S2 支撑跌破回测'], ['L1', 'L1 需求区支撑'], ['L2', 'L2 阻力突破回测']];
  function direction(value: string) {
    const side = value as 'long' | 'short';
    change({ direction: side, ...(trade.revision === 0 && trade.direction === null ? { model: side === 'long' ? 'L1' : 'S1' } : {}), ...(framework === 'G1' ? { strategy: side === 'long' ? 'G1-L' : 'G1-S', g1: { ...(trade.g1 ?? blankG1(settings.g1)), side } } : {}) });
  }
  function selectFramework(value: string) {
    const framework = value as 'G1' | 'independent' | 'pending', side = trade.direction ?? 'short';
    change({ framework, strategy: framework === 'G1' ? side === 'long' ? 'G1-L' : 'G1-S' : framework === 'independent' ? 'none' : undefined, ...(framework === 'G1' ? { g1: { ...(trade.g1 ?? blankG1(settings.g1)), side } } : {}) });
  }
  return <section className="form-section"><h3>快速开仓 · 选择分类</h3>{snapshot.capturedAt&&<p className="muted-note">方向、策略框架、模型和入场方式属于已冻结的开仓分类。</p>}<fieldset className="editor-fieldset" disabled={!!snapshot.capturedAt}><div style={{ display: 'grid', gap: 12 }}><Choices large label="交易方向" value={trade.direction} options={[["long", "做多"], ["short", "做空"]]} change={direction}/><Choices label="策略框架 · 与模型独立" value={framework} options={[["G1", "G1顺势交易"], ["independent", "非G1独立结构交易"], ["pending", "待确认"]]} change={selectFramework}/><Choices label="入场模型" value={trade.model} options={modelOptions} change={model => change({ model: model as TradeRecord['model'] })}/><fieldset className="editor-fieldset" disabled={!!snapshot.capturedAt}><Choices label="入场方式" value={snapshot.entryApproach} options={ENTRY_APPROACH_OPTIONS} change={entryApproach => change({ entrySnapshot: { ...snapshot, entryApproach: entryApproach as EntrySnapshot['entryApproach'] } })}/></fieldset></div></fieldset>{framework === 'pending' && <p className="muted-note">待确认会保留为未知分类，不根据模型或自由文字自动归入 G1 / 非G1。</p>}</section>;
}

export function EntrySnapshotFields({ trade, change, read, commit }: { trade: TradeRecord; change: Change; read: () => TradeRecord; commit: () => void }) {
  const snapshot = trade.entrySnapshot ?? blankEntrySnapshot(), locked = !!snapshot.capturedAt;
  const patch = (value: Partial<EntrySnapshot>, render = true) => change({ entrySnapshot: { ...(read().entrySnapshot ?? blankEntrySnapshot()), ...value } }, render);
  return <section className="form-section"><h3>开仓时的市场结构</h3>{locked && <p className="muted-note">已保存的开仓快照保持不变。后续市场变化请在每日观察或持仓备注中另行记录。</p>}<fieldset className="editor-fieldset" disabled={locked}><div style={{ display: 'grid', gap: 9 }}>{(['structure4H', 'structure1H', 'structure15m'] as const).map((key, index) => <Choices key={key} label={['4H结构', '1H结构', '15m结构'][index]} value={snapshot[key]} options={STRUCTURE_OPTIONS} change={value => patch({ [key]: value })}/>)}<Choices label="市场环境 Regime" value={snapshot.regime} options={REGIME_OPTIONS} change={value => patch({ regime: value as EntrySnapshot['regime'] })}/><Choices label="Trigger确认状态" value={snapshot.confirmation} options={CONFIRMATION_OPTIONS} change={value => patch({ confirmation: value as EntrySnapshot['confirmation'] })}/></div><details className="form-section" style={{ marginTop: 12 }}><summary>关键位置、Trigger与逻辑失效 · 选填</summary><div style={{ display: 'grid', gap: 12, paddingTop: 12 }}><MultiChoices label="当前价格位置" values={snapshot.locations} options={LOCATION_OPTIONS} change={values => patch({ locations: values as EntrySnapshot['locations'] })}/><Choices label="Setup阶段" value={snapshot.setupStage} options={SETUP_STAGE_OPTIONS} change={value => patch({ setupStage: value as EntrySnapshot['setupStage'] })}/><MultiChoices label="Trigger类型" values={snapshot.triggerTypes} options={TRIGGER_OPTIONS} change={values => patch({ triggerTypes: values as EntrySnapshot['triggerTypes'] })}/><Choices label="逻辑失效类型 · 与硬止损分别保存" value={snapshot.invalidationType} options={INVALIDATION_OPTIONS} change={value => patch({ invalidationType: value as EntrySnapshot['invalidationType'] })}/><div className="form-grid"><Num label="关键价格 · 选填" value={snapshot.keyPrice} onChange={keyPrice => patch({ keyPrice })}/><Num label="逻辑失效参考价格 · 选填" value={snapshot.invalidationPrice} onChange={invalidationPrice => patch({ invalidationPrice })}/></div><Choices label="波动率标签 · 选填" value={snapshot.volatility} options={VOLATILITY_OPTIONS} change={value => patch({ volatility: value as EntrySnapshot['volatility'] })}/><BufferedText label="其他 / 自定义结构说明" value={snapshot.notes} rows={2} onDraft={notes => patch({ notes }, false)} onCommit={commit}/></div></details></fieldset></section>;
}

export function HistoricalSupplementFields({ trade, change, read, commit }: { trade: TradeRecord; change: Change; read: () => TradeRecord; commit: () => void }) {
  if (trade.revision === 0 || trade.recordType === 'plan') return null;
  const value = trade.historicalSupplement ?? { confirmed: false, evidence: 'pre-entry-record' as const, sourceNote: '', fields: [], confirmedAt: null };
  const patch = (update: Partial<typeof value>, render = true) => change({ historicalSupplement: { ...(read().historicalSupplement ?? value), ...update } }, render);
  return <details className="form-section"><summary>历史缺失分类 / 快照的人工补录确认</summary><div style={{ display: 'grid', gap: 12, paddingTop: 12 }}><MultiChoices label="本次确认补录的字段" values={value.fields} options={[["framework", "策略框架"], ["entrySnapshot", "开仓市场快照"]]} change={fields => patch({ fields: fields as typeof value.fields })}/><label className="form-field"><span className="field-label">确认依据</span><select value={value.evidence} onChange={event => patch({ evidence: event.target.value as typeof value.evidence })}><option value="pre-entry-record">原始事前保存记录</option><option value="user-memory">本人对当时情况的明确记忆</option><option value="other">其他明确依据</option></select></label><BufferedText label="说明原始依据 · 补录时必填" value={value.sourceNote} rows={2} onDraft={sourceNote => patch({ sourceNote }, false)} onCommit={commit}/><label className="checkbox-label"><input type="checkbox" checked={value.confirmed} onChange={event => patch({ confirmed: event.target.checked, confirmedAt: null })}/>我确认以上补录反映开仓时事实，不按事后行情或自由文字自动推断。</label><p className="muted-note">无法核对时保持未知。已经冻结的开仓快照不能在此覆盖；风险预算补录需要原始事前记录。</p></div></details>;
}

export function AdditionalTargets({ trade, change }: { trade: TradeRecord; change: Change }) {
  const targets = trade.targetPrices ?? (trade.targetPrice === null ? [] : [trade.targetPrice]);
  return <details className="form-section"><summary>更多计划目标 · 最多三个，选填</summary><div className="form-grid" style={{ paddingTop: 12 }}>{[1, 2].map(index => <Num key={index} label={`计划目标 ${index + 1}`} value={targets[index] ?? null} onChange={value => { const next = [trade.targetPrice, targets[1] ?? null, targets[2] ?? null]; next[index] = value; change({ targetPrices: next.filter((target): target is number => target !== null) }); }}/>)}</div></details>;
}

export function RiskAcknowledgement({ trade, settings, change, read, commit }: { trade: TradeRecord; settings: Settings; change: Change; read: () => TradeRecord; commit: () => void }) {
  const risk = vnextRiskAssessment(trade, settings);
  if (!risk.overNormal && !risk.overHard) return null;
  return <div className={risk.overHard ? 'error-banner' : 'warning-note'} style={{ display: 'block' }} role="alert">{risk.overHard ? <p>完整交易风险超过硬上限 {risk.hardLimit} {risk.currency}，不能作为合规新计划提交。实际已发生的成交仍可如实登记，并标记风险违规。</p> : <p>风险超过常规预算 {risk.normalMax} {risk.currency}，尚未超过硬上限。保存前请确认超预算原因。</p>}<BufferedText label="超常规预算原因 / 真实风险违规说明" value={trade.overNormalReason ?? ''} rows={2} onDraft={overNormalReason => change({ overNormalReason }, false)} onCommit={commit}/>{risk.overHard && trade.recordType === 'plan' && <p>请调整计划风险；若已实际成交，请在高级信息中切换为实际成交并核对真实价格和数量。</p>}</div>;
}

export function VNextPsychology({ trade, change, read, commit }: { trade: TradeRecord; change: Change; read: () => TradeRecord; commit: () => void }) {
  const p = trade.psychology ?? blankPsychology();
  const patch = (value: Partial<typeof p>, render = true) => change({ psychology: { ...(read().psychology ?? blankPsychology()), ...value } }, render);
  return <details className="form-section"><summary>心理状态、外部意见与执行纪律 · 选填</summary><div style={{ display: 'grid', gap: 12, paddingTop: 12 }}><MultiChoices label="情绪" values={p.emotions ?? []} options={EMOTION_OPTIONS} change={values => patch({ emotions: values as typeof p.emotions })}/><div className="form-grid">{(['energy', 'fomo', 'fear'] as const).map((key, index) => <label className="form-field" key={key}><span className="field-label">{['精力', 'FOMO', '恐惧'][index]} · 1—10</span><select value={p[key] ?? ''} onChange={event => patch({ [key]: event.target.value === '' ? null : Number(event.target.value) })}><option value="">未填写</option>{p[key] === 0 && <option value="0">0 · 历史原值</option>}{Array.from({ length: 10 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}</select></label>)}</div><Choices label="外部意见依赖" value={p.externalOpinion} options={EXTERNAL_OPINION_OPTIONS} change={value => patch({ externalOpinion: value as typeof p.externalOpinion, kol: value === 'not_applicable' ? null : value !== 'none', kolChangedPlan: value === 'not_applicable' ? null : value === 'changed_judgment' })}/><Choices label="执行纪律 · 不按盈亏自动评价" value={p.discipline} options={DISCIPLINE_OPTIONS} change={value => patch({ discipline: value as typeof p.discipline })}/>{(p.discipline === 'partial' || p.discipline === 'violated') && <MultiChoices label="具体偏离原因" values={p.deviationReasons ?? []} options={DEVIATION_OPTIONS} change={values => patch({ deviationReasons: values as typeof p.deviationReasons })}/>}<BufferedText label="身体 / 心理补充说明" value={p.physicalState} rows={2} onDraft={physicalState => patch({ physicalState }, false)} onCommit={commit}/><p className="muted-note">未填写的评分保留为空，不记成 0；纪律选择和盈利、亏损分别记录。</p></div></details>;
}

export function CloseReasons({ close, change }: { close: CloseEvent; change: (patch: Partial<CloseEvent>) => void }) {
  const reasons = close.reasons ?? [];
  return <div style={{ display: 'grid', gap: 12 }}><MultiChoices label="平仓原因" values={reasons} options={CLOSE_REASON_OPTIONS} change={values => change({ reasons: values as CloseEvent['reasons'], primaryReason: close.primaryReason && values.includes(close.primaryReason) ? close.primaryReason : null })}/><label className="form-field"><span className="field-label">主要平仓原因 · 从已选原因中确认</span><select value={close.primaryReason ?? ''} onChange={event => change({ primaryReason: event.target.value as CloseEvent['primaryReason'] || null })}><option value="">未确认 / 未记录</option>{CLOSE_REASON_OPTIONS.filter(([code]) => reasons.includes(code)).map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label></div>;
}
