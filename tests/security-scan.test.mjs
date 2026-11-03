import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { scanContent, scanRepository } from '../scripts/security-scan.mjs';

function removeFixture(directory) {
  const base = resolve(tmpdir()), target = resolve(directory);
  assert(target.startsWith(base + sep));
  assert(/^demo-(?:security|index)-/.test(target.slice(base.length + 1)));
  rmSync(target, { recursive: true, force: true });
}

test('scanner reports rule/location without exposing matched credentials', () => {
  const value = ['ghp', 'a'.repeat(36)].join('_');
  const result = scanContent('example.txt', 'header\n' + value);
  assert.deepEqual(result, [{ source: 'example.txt', rule: 'github-token', line: 2 }]);
  assert.equal(JSON.stringify(result).includes(value), false);
  assert.equal(scanContent('fixture.txt', 'nobody@example.invalid').length, 0);
  assert.equal(scanContent('app/example.ts', 'fetch("https://' + 'remote.invalid/api")')[0].rule, 'external-runtime-request');
});

test('Git scanner catches tracked ignored files and secrets removed from current history tip', t => {
  const root = mkdtempSync(join(tmpdir(), 'demo-security-'));
  t.after(() => removeFixture(root));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Demo Maintainer');
  git('config', 'user.email', 'demo@example.invalid');
  writeFileSync(join(root, '.gitignore'), '.env\n');
  const secret = ['github', 'pat', 'a'.repeat(50)].join('_');
  writeFileSync(join(root, 'old.txt'), secret);
  git('add', '.'); git('commit', '-m', 'Demo unsafe fixture');
  writeFileSync(join(root, 'old.txt'), 'redacted\n');
  git('add', '.'); git('commit', '-m', 'Remove fixture secret');
  const result = scanRepository(root);
  assert.equal(result.historyScanned, true);
  assert(result.checkedGitObjects > 0);
  assert(result.findings.some(finding => finding.source.startsWith('git:') && finding.rule === 'github-token'));
  assert.equal(JSON.stringify(result).includes(secret), false);
  writeFileSync(join(root, '.env'), 'DEMO=1\n'); git('add', '-f', '.env');
  assert(scanRepository(root).findings.some(finding => finding.source === '.env' && finding.rule === 'credential-or-deployment-file'));
});

test('scanner checks staged object bytes even if a clean working file replaces them', t => {
  const root = mkdtempSync(join(tmpdir(), 'demo-index-'));
  t.after(() => removeFixture(root));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '--initial-branch=main');
  const secret = ['sk', 'x'.repeat(40)].join('-');
  writeFileSync(join(root, 'staged.txt'), secret); git('add', '.');
  writeFileSync(join(root, 'staged.txt'), 'safe working copy\n');
  const result = scanRepository(root);
  assert(result.findings.some(finding => finding.source.startsWith('git:') && finding.rule === 'api-token'));
  assert(result.findings.some(finding => finding.source === 'staged:staged.txt' && finding.rule === 'api-token'));
  writeFileSync(join(root, '.env'), 'DEMO=1\n'); git('add', '.env'); unlinkSync(join(root, '.env'));
  assert(scanRepository(root).findings.some(finding => finding.source === 'staged:.env' && finding.rule === 'credential-or-deployment-file'));
});

test('nested Git trees retain full paths for the Demo screenshot allowlist', t => {
  const root = mkdtempSync(join(tmpdir(), 'demo-security-'));
  t.after(() => removeFixture(root));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Demo Maintainer');
  git('config', 'user.email', 'demo@example.invalid');
  const screenshots = join(root, 'docs', 'screenshots');
  mkdirSync(screenshots, { recursive: true });
  const demoBytes = Buffer.from([0, 1, 2, 3]); // Invented scanner fixture, never a user attachment.
  writeFileSync(join(screenshots, 'demo-overview.jpg'), demoBytes);
  git('add', '.'); git('commit', '-m', 'Demo nested screenshot fixture');
  const clean = scanRepository(root);
  assert.equal(clean.historyScanned, true);
  assert.deepEqual(clean.findings, []);
  writeFileSync(join(screenshots, 'unreviewed.jpg'), demoBytes);
  git('add', '.'); git('commit', '-m', 'Demo rejected attachment fixture');
  const rejected = scanRepository(root);
  assert.equal(rejected.passed, false);
  assert(rejected.findings.some(finding => finding.source.startsWith('git:') && finding.source.endsWith('unreviewed.jpg') && finding.rule === 'unreviewed-binary-attachment'));
});
