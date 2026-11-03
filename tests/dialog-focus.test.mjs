import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const hookSource = readFileSync(new URL('../app/use-dialog-focus.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(hookSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

// A hook-lifecycle test double: retain refs and rerun effects only when their
// dependencies change. This exercises focus calls without a browser or IME.
function harness() {
  const slots = [], layouts = [], effects = [], listeners = new Map();
  let cursor = 0;
  const document = { activeElement: null, body: { style: { overflow: 'auto' } }, addEventListener(type, fn) { listeners.set(type, fn); }, removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); } };
  const control = () => ({ focusCount: 0, focus() { this.focusCount++; document.activeElement = this; } });
  const trigger = control(), first = control(), last = control();
  const container = { ...control(), querySelectorAll() { return [first, last]; } };
  document.activeElement = trigger;
  function effect(queue, fn, deps) {
    const index = cursor++, old = slots[index];
    if (!old || !deps || deps.some((value, i) => !Object.is(value, old.deps?.[i]))) {
      queue.push(() => { old?.cleanup?.(); slots[index] = { deps, cleanup: fn() }; });
    }
  }
  const react = {
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useLayoutEffect(fn, deps) { effect(layouts, fn, deps); },
    useEffect(fn, deps) { effect(effects, fn, deps); },
  };
  const module = { exports: {} };
  runInNewContext(compiled, { exports: module.exports, require(name) { assert.equal(name, 'react'); return react; }, document });
  function render(close) {
    cursor = 0;
    const ref = module.exports.useDialogFocus(close);
    ref.current = container;
    while (layouts.length) layouts.shift()();
    while (effects.length) effects.shift()();
  }
  function key(event) { let prevented = false; listeners.get('keydown')?.({ shiftKey: false, isComposing: false, keyCode: 0, preventDefault() { prevented = true; }, ...event }); return prevented; }
  function unmount() { slots.forEach(slot => slot.cleanup?.()); }
  return { render, key, unmount, document, trigger, first, last, container, listeners };
}

test('typing updates retain input focus and caret ownership instead of refocusing the dialog', () => {
  const h = harness(); h.render(() => {}); h.first.focus();
  for (const value of ['z', 'zh', 'zhong', '中', '中文', '中文连续输入']) h.render(() => value);
  assert.equal(h.document.activeElement, h.first);
  assert.equal(h.container.focusCount, 1);
  assert.equal(h.first.focusCount, 1);
  assert.equal(h.trigger.focusCount, 0);
  assert.equal(h.document.body.style.overflow, 'hidden');
});

test('Escape uses the latest unsaved/saving guard while composition events stay with the IME', () => {
  const h = harness(); let old = 0, current = 0;
  h.render(() => old++); h.render(() => current++);
  h.key({ key: 'Escape', isComposing: true });
  h.key({ key: 'Escape', keyCode: 229 });
  assert.equal(current, 0);
  h.key({ key: 'Escape' });
  assert.equal(current, 1); assert.equal(old, 0);
});

test('Tab trapping and focus/scroll restoration still work when the dialog closes', () => {
  const h = harness(); h.render(() => {});
  assert.equal(h.key({ key: 'Tab' }), true); assert.equal(h.document.activeElement, h.first);
  assert.equal(h.key({ key: 'Tab', shiftKey: true }), true); assert.equal(h.document.activeElement, h.last);
  assert.equal(h.key({ key: 'Tab' }), true); assert.equal(h.document.activeElement, h.first);
  h.unmount();
  assert.equal(h.document.body.style.overflow, 'auto');
  assert.equal(h.document.activeElement, h.trigger);
  assert.equal(h.listeners.size, 0);
});
