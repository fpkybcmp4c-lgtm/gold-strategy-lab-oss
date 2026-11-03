import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../app/review-export.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.React,
    esModuleInterop: true,
  },
}).outputText;
const settle = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };

// Retain the actual component's hook state and invoke its rendered controls.
// Only React and browser transport/clipboard/download APIs are test doubles.
function harness() {
  const slots = [], requests = [], copies = [], blobs = [], anchors = [], revoked = [], timers = [];
  let cursor = 0, tree, rejectClipboard = false;
  const dialog = { open: false, showModal() { this.open = true; }, close() { this.open = false; } };
  const textArea = { focused: false, selected: false, focus() { this.focused = true; }, select() { this.selected = true; } };
  const react = {
    Fragment: 'Fragment',
    createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
    useState(initial) {
      const index = cursor++;
      slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, value => { slots[index].value = typeof value === 'function' ? value(slots[index].value) : value; }];
    },
    useRef(initial) { return slots[cursor++] ??= { current: initial }; },
    useId() { const index = cursor++; return slots[index] ??= 'review-export-test'; },
  };
  const module = { exports: {} };
  runInNewContext(compiled, {
    exports: module.exports,
    require(name) {
      if (name === 'react') return react;
      if (name === 'lucide-react') return { Copy: 'Copy', Download: 'Download', X: 'X' };
      if (name.endsWith('/domain')) return { todayCN: () => '2026-10-12' };
      throw new Error(name);
    },
    Error, JSON, Blob, URLSearchParams,
    fetch(url, options) {
      return new Promise(resolve => requests.push({ url, options, resolve, replied: false }));
    },
    navigator: { clipboard: { async writeText(value) { copies.push(value); if (rejectClipboard) throw new Error('Clipboard denied'); } } },
    URL: {
      createObjectURL(blob) { blobs.push(blob); return `blob:review/${blobs.length}`; },
      revokeObjectURL(url) { revoked.push(url); },
    },
    window: { setTimeout(callback) { timers.push(callback); } },
    document: {
      createElement(tag) {
        assert.equal(tag, 'a');
        return { clicked: false, removed: false, click() { this.clicked = true; }, remove() { this.removed = true; } };
      },
      body: { appendChild(link) { anchors.push(link); } },
    },
  });
  function nodes(node = tree) {
    if (Array.isArray(node)) return node.flatMap(child => nodes(child));
    if (!node || typeof node !== 'object') return [];
    return [node, ...nodes(node.props?.children)];
  }
  function text(node = tree) {
    if (Array.isArray(node)) return node.map(child => text(child)).join('');
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    return node && typeof node === 'object' ? text(node.props?.children) : '';
  }
  function find(type, predicate = () => true) {
    return nodes().find(node => node.type === type && predicate(node.props, node));
  }
  function render() {
    cursor = 0;
    tree = module.exports.ReviewExport();
    find('dialog').props.ref.current = dialog;
    const input = find('textarea');
    if (input) input.props.ref.current = textArea;
    return tree;
  }
  function button(label) {
    const node = find('button', (_props, element) => text(element) === label);
    assert.ok(node, `Missing button: ${label}`);
    return node.props;
  }
  async function reply(body, { status = 200, invalidJson = false } = {}) {
    const request = requests.find(item => !item.replied);
    assert.ok(request, 'No pending fetch');
    request.replied = true;
    request.resolve({
      ok: status >= 200 && status < 300,
      status,
      async json() { if (invalidJson) throw new SyntaxError('Unexpected HTML'); return body; },
    });
    await settle();
    render();
  }
  return {
    render, find, text, button, reply, requests, copies, blobs, anchors, revoked, dialog, textArea,
    denyClipboard() { rejectClipboard = true; },
    flushTimers() { while (timers.length) timers.shift()(); },
  };
}

function payload(version, note = '本次从服务端读取的完整复盘。') {
  return {
    source: { name: '黄金策略实验室', description: '来源对象的额外说明' },
    generatedAt: '2026-10-12T08:00:00.000Z',
    dataVersion: version,
    trades: [{ id: `trade-${version}`, note, entries: [{ quantity: 2, price: 4000 }] }],
    daily: { note: '中文末尾。\n第二段。' },
  };
}

function assertFreshRequest(request, query) {
  assert.equal(request.url, `/api/review?${query}`);
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.credentials, 'same-origin');
  assert.equal(request.options.cache, 'no-store');
}

test('copy waits for a fresh same-origin response on every click and does not reuse the first payload', async () => {
  const h = harness(); h.render();
  h.button('复盘数据').onClick(); assert.equal(h.dialog.open, true);
  h.button('读取并复制').onClick(); h.render();
  assert.equal(h.requests.length, 1);
  assertFreshRequest(h.requests[0], 'scope=today');
  assert.equal(h.copies.length, 0);
  assert.equal(h.button('读取中…').disabled, true);
  assert.match(h.text(), /正在读取最新复盘数据/);
  await h.reply(payload('first'));
  assert.deepEqual(JSON.parse(h.copies[0]), payload('first'));
  assert.match(h.text(), /已复制本次接口返回/);
  assert.match(h.text(), /来源：黄金策略实验室/);
  assert.doesNotMatch(h.text(), /来源对象的额外说明/);

  h.button('读取并复制').onClick(); h.render();
  assert.equal(h.requests.length, 2);
  assertFreshRequest(h.requests[1], 'scope=today');
  assert.equal(h.copies.length, 1);
  assert.doesNotMatch(h.text(), /数据版本：first|已复制本次接口返回/);
  await h.reply(payload('second'));
  assert.deepEqual(JSON.parse(h.copies[1]), payload('second'));
});

test('HTTP, JSON-reported and invalid JSON failures never copy or display an older result', async () => {
  const h = harness(); h.render();
  h.button('读取并复制').onClick(); await h.reply(payload('cached-result'));
  const failures = [
    { body: { error: '未授权读取' }, options: { status: 401 }, message: /未授权读取/ },
    { body: { error: { message: '数据库暂不可用' } }, options: { status: 200 }, message: /数据库暂不可用/ },
    { body: null, options: { status: 200, invalidJson: true }, message: /没有返回有效 JSON/ },
  ];
  for (const failure of failures) {
    h.button('读取并复制').onClick(); h.render();
    assert.doesNotMatch(h.text(), /cached-result|已复制本次接口返回/);
    await h.reply(failure.body, failure.options);
    assert.equal(h.copies.length, 1);
    assert.match(h.text(h.find('div', props => props.role === 'alert')), failure.message);
    assert.equal(h.find('textarea'), undefined);
    assert.equal(h.find('div', props => props.className === 'compact-empty'), undefined);
    assert.doesNotMatch(h.text(), /cached-result|已复制本次接口返回/);
  }
});

test('clipboard rejection shows the complete newly fetched JSON and supports manual selection', async () => {
  const h = harness(); h.render(); h.denyClipboard();
  const latest = payload('fresh-clipboard-fallback', '这是本次读取的数据，包含\n完整的中文文本。');
  h.button('读取并复制').onClick(); await h.reply(latest);
  const input = h.find('textarea').props;
  assert.equal(input.readOnly, true);
  assert.equal(input.value, JSON.stringify(latest, null, 2));
  assert.deepEqual(JSON.parse(h.copies[0]), latest);
  assert.match(h.text(), /浏览器未允许自动复制/);
  assert.doesNotMatch(h.text(), /已复制本次接口返回/);
  h.button('选中全部文本').onClick();
  assert.equal(h.textArea.focused, true);
  assert.equal(h.textArea.selected, true);
  assert.equal(h.find('div', props => props.role === 'alert'), undefined);
});

test('a failed refresh removes prior manual-copy text instead of offering it as current data', async () => {
  const h = harness(); h.render(); h.denyClipboard();
  h.button('读取并复制').onClick(); await h.reply(payload('old-manual-text'));
  assert.match(h.find('textarea').props.value, /old-manual-text/);
  h.button('读取并复制').onClick(); h.render();
  assert.equal(h.find('textarea'), undefined);
  await h.reply({ error: '读取服务不可用' }, { status: 503 });
  assert.equal(h.copies.length, 1);
  assert.equal(h.find('textarea'), undefined);
  assert.doesNotMatch(h.text(), /old-manual-text|浏览器未允许自动复制/);
  assert.match(h.text(h.find('div', props => props.role === 'alert')), /读取服务不可用/);
});

test('download fetches fresh data instead of the last copied data and downloads the complete response', async () => {
  const h = harness(); h.render();
  h.button('读取并复制').onClick(); await h.reply(payload('previous-copy'));
  h.find('select').props.onChange({ target: { value: 'positions' } }); h.render();
  h.button('下载 JSON').onClick(); h.render();
  assertFreshRequest(h.requests[1], 'scope=positions');
  assert.equal(h.blobs.length, 0);
  assert.equal(h.copies.length, 1);
  const latest = payload('current-positions'); await h.reply(latest);
  assert.equal(h.copies.length, 1);
  assert.equal(h.blobs.length, 1);
  assert.deepEqual(JSON.parse(await h.blobs[0].text()), latest);
  assert.equal(h.blobs[0].type, 'application/json;charset=utf-8');
  assert.equal(h.anchors[0].download, 'gold-review-positions-2026-10-12.json');
  assert.equal(h.anchors[0].clicked, true);
  assert.equal(h.anchors[0].removed, true);
  assert.match(h.text(), /发起 JSON 下载/);
  h.flushTimers(); assert.deepEqual(h.revoked, ['blob:review/1']);
});

test('recent seven days uses an inclusive Beijing range; invalid custom dates prevent requests', async () => {
  const h = harness(); h.render();
  h.find('select').props.onChange({ target: { value: 'week' } }); h.render();
  h.button('读取并复制').onClick();
  assertFreshRequest(h.requests[0], 'scope=range&start=2026-10-06&end=2026-10-12');
  await h.reply(payload('seven-days'));
  h.find('select').props.onChange({ target: { value: 'range' } }); h.render();
  h.find('input', props => props.value === '2026-10-06').props.onChange({ target: { value: '2026-10-13' } }); h.render();
  h.button('读取并复制').onClick(); h.render();
  assert.equal(h.requests.length, 1);
  assert.match(h.text(h.find('div', props => props.role === 'alert')), /开始日期不能晚于结束日期/);
  assert.doesNotMatch(h.text(), /seven-days|已复制本次接口返回/);
});

test('long versions remain complete in the exported JSON and title while the source is displayed by name', async () => {
  const h = harness(); h.render();
  const version = `sha256:${'abcd'.repeat(30)}`;
  h.button('读取并复制').onClick(); await h.reply(payload(version));
  const versionNode = h.find('span', props => props.title === version);
  assert.ok(versionNode);
  assert.ok(h.text(versionNode).length < version.length);
  assert.equal(JSON.parse(h.copies[0]).dataVersion, version);
  assert.equal(h.find('div', props => props.className === 'info-content').props.style.overflowY, 'auto');
});
