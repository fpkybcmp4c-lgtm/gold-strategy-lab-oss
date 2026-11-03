import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BYTES = 25 * 1024 * 1024;
const ignoredDirectories = new Set(['.git', 'node_modules', '.next', 'dist', 'coverage', 'data', 'backups', 'logs', 'playwright-report', 'test-results']);
const normalize = path => path.split(sep).join('/');
const rules = [
  ['hosted-private-site', /(?:[a-z0-9-]+\.)+chatgpt\.site\b/ig],
  ['site-project-identity', /\b(?:appgprj|oaiapp)_[a-f0-9]{20,}\b/ig],
  ['cloud-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
  ['api-token', /\bsk-(?:proj-)?[A-Za-z0-9_-]{30,}\b/g],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ['credential-url', /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|https?):\/\/[^\s/:'"]+:[^\s/@'"]+@/ig],
  ['hardcoded-secret', /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|database[_-]?password)\s*[:=]\s*['"][A-Za-z0-9_+/.=-]{16,}['"]/ig],
  ['hardcoded-owner', /\b(?:owner_id|userId|user_id|account_user_id)\s*[:=]\s*['"][a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}['"]/ig],
  ['machine-private-path', /\b(?:[A-Z]:[\\/]Users[\\/](?!Public\b|example\b)[^\s'"<>]+|\/Users\/[^\s'"<>]+|\/home\/(?!runner\b)[^\s'"<>]+)/g],
];

function pathRule(path) {
  const clean = normalize(path);
  if (/(^|\/)(?:\.openai|\.wrangler|\.sites-runtime|\.sites-checkout|backups|logs|data)(\/|$)/i.test(clean)) return 'runtime-or-production-directory';
  if (/(^|\/)(?:\.env(?:\..*)?|id_rsa|id_ed25519|credentials(?:\.json)?|wrangler(?:\.jsonc?|\.toml))$/i.test(clean) && !/(?:^|\/)\.env\.example$/.test(clean)) return 'credential-or-deployment-file';
  if (/\.(?:db|sqlite|sqlite3|db-wal|db-shm|sqlite-wal|sqlite-shm|log|bak|dump|pem|key|p12|pfx|zip|tar|gz|7z)$/i.test(clean)) return 'private-data-or-archive-file';
  if (/\.(?:png|jpe?g|webp|gif|avif|heic|pdf)$/i.test(clean) && !/^docs\/screenshots\/demo[-\w]*\.(?:png|jpe?g|webp)$/i.test(clean)) return 'unreviewed-binary-attachment';
  return null;
}

export function scanContent(source, content, { runtime = /^(?:app|lib|components|hooks)\//.test(source), license = /(?:^|\/)(?:LICENSE[^/]*|[^/]+\.LICENSE\.md)$/i.test(source) } = {}) {
  const findings = [];
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : content;
  const add = (rule, index) => findings.push({ source, rule, line: text.slice(0, index).split('\n').length });
  for (const [rule, pattern] of rules) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) add(rule, match.index);
  }
  if (!license) for (const match of text.matchAll(/\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/ig)) {
    if (!/(?:^|\.)(?:example\.(?:com|org|net)|invalid|test|localhost)$/.test(match[1].toLowerCase())) add('personal-email', match.index);
  }
  if (runtime) {
    for (const match of text.matchAll(/\b(?:fetch|WebSocket|EventSource)\s*\(\s*['"`]https?:\/\/([^\s/'"`]+)/g)) {
      if (!/^(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(match[1])) add('external-runtime-request', match.index);
    }
    for (const match of text.matchAll(/(?:from\s*|import\s*\()['"](?:cloudflare:workers|@openai\/|@sites\/)/g)) add('hosted-runtime-dependency', match.index);
  }
  return findings;
}

function git(root, args, encoding = 'utf8') {
  return execFileSync('git', ['-C', root, ...args], { encoding, maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

export function sameDirectory(left, right) {
  // Git and Node can spell the same Windows directory differently (8.3 aliases
  // or casing). File identity preserves the root boundary without case-folding
  // distinct directories on a case-sensitive volume.
  const a = statSync(left, { bigint: true }), b = statSync(right, { bigint: true });
  if (!a.isDirectory() || !b.isDirectory()) return false;
  if (a.ino !== 0n && b.ino !== 0n) return a.dev === b.dev && a.ino === b.ino;
  return realpathSync.native(left) === realpathSync.native(right);
}

function rootDetectionError(reason) {
  const error = new Error('Local Git metadata exists but the selected repository root could not be verified (' + reason + ').');
  error.code = 'GIT_ROOT_UNVERIFIED';
  error.reason = reason;
  return error;
}

function gitFailureReason(error) {
  const detail = String(error.stderr ?? '');
  if (/dubious ownership|safe\.directory/i.test(detail)) return 'unsafe-ownership';
  if (error.code === 'ENOENT') return 'git-unavailable';
  if (/not a git repository/i.test(detail)) return 'invalid-git-metadata';
  return 'git-command-failed';
}

function walk(root, directory = root) {
  const paths = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const file = resolve(directory, entry.name);
    if (entry.isDirectory()) paths.push(...walk(root, file)); else paths.push(normalize(relative(root, file)));
  }
  return paths;
}

export function scanRepository(root, { history = true } = {}) {
  root = realpathSync.native(root);
  const metadata = lstatSync(resolve(root, '.git'), { throwIfNoEntry: false });
  if (metadata?.isSymbolicLink()) throw rootDetectionError('symlinked-git-metadata');
  let ownGit = false;
  let topLevel;
  try { topLevel = git(root, ['rev-parse', '--show-toplevel']).trim(); }
  catch (error) { if (metadata) throw rootDetectionError(gitFailureReason(error)); }
  if (metadata && !topLevel) throw rootDetectionError('missing-root');
  if (topLevel) {
    try { ownGit = sameDirectory(root, topLevel); }
    catch { if (metadata) throw rootDetectionError('root-identity-unreadable'); }
    if (metadata && !ownGit) throw rootDetectionError('different-root');
  }
  const findings = [];
  const current = ownGit ? git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean) : walk(root);
  let checkedFiles = 0, checkedGitObjects = 0;
  const inspectFile = (path, bytes, source = path) => {
    const rule = pathRule(path);
    if (rule) findings.push({ source, rule });
    if (bytes.length > MAX_BYTES) { findings.push({ source, rule: 'oversized-unreviewed-file' }); return; }
    if (!bytes.includes(0)) findings.push(...scanContent(source, bytes, { runtime: /^(?:app|lib|components|hooks)\//.test(path), license: /(?:^|\/)(?:LICENSE[^/]*|[^/]+\.LICENSE\.md)$/i.test(path) }));
  };
  for (const path of [...new Set(current)]) {
    const full = resolve(root, path);
    if (!full.startsWith(root + sep)) { findings.push({ source: path, rule: 'path-escape' }); continue; }
    if (!existsSync(full)) { const rule = pathRule(path); if (rule) findings.push({ source: path, rule }); continue; }
    if (lstatSync(full).isSymbolicLink()) { findings.push({ source: path, rule: 'unreviewed-symlink' }); continue; }
    if (!lstatSync(full).isFile()) continue;
    checkedFiles++;
    inspectFile(path, readFileSync(full));
  }
  if (ownGit && history) {
    // Inspect the index with its original paths, even when the working file was
    // changed/deleted after staging. An index-only blob has no rev-list pathname.
    for (const entry of git(root, ['ls-files', '--stage', '-z']).split('\0').filter(Boolean)) {
      const tab = entry.indexOf('\t'), [mode, oid] = entry.slice(0, tab).split(' '), path = entry.slice(tab + 1);
      if (mode === '120000') findings.push({ source: 'staged:' + path, rule: 'unreviewed-symlink' });
      inspectFile(path, git(root, ['cat-file', 'blob', oid], null), 'staged:' + path);
    }
    // --batch-all-objects includes dangling/unreachable objects and packed objects,
    // so removing a secret in a later commit is insufficient to pass this check.
    const objectLines = git(root, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype) %(objectsize)']).trim().split('\n').filter(Boolean);
    const names = new Map();
    const named = git(root, ['rev-list', '--objects', '--all', '--reflog']);
    for (const line of named.split('\n')) { const space = line.indexOf(' '); if (space > 0) names.set(line.slice(0, space), line.slice(space + 1).replace(/\r$/, '')); }
    for (const line of objectLines) {
      const [oid, type, size] = line.trim().split(' ');
      checkedGitObjects++;
      const source = `git:${oid.slice(0, 12)}${names.has(oid) ? ':' + names.get(oid) : ':' + type}`;
      if (Number(size) > MAX_BYTES) { findings.push({ source, rule: 'oversized-unreviewed-object' }); continue; }
      if (type === 'blob') inspectFile(names.get(oid) ?? '', git(root, ['cat-file', 'blob', oid], null), source);
      else if (type === 'commit' || type === 'tag') findings.push(...scanContent(source, git(root, ['cat-file', '-p', oid]), { runtime: false, license: false }));
      else if (type === 'tree') {
        const entries = git(root, ['ls-tree', '-rz', oid]).split('\0').filter(Boolean);
        const treeBase = names.get(oid) ?? '';
        for (const entry of entries) {
          const childPath = entry.slice(entry.indexOf('\t') + 1);
          const path = treeBase ? treeBase + '/' + childPath : childPath, rule = pathRule(path);
          if (rule) findings.push({ source: source + ':' + path, rule });
          if (entry.startsWith('120000 ')) findings.push({ source: source + ':' + path, rule: 'unreviewed-symlink' });
        }
      }
    }
    findings.push(...scanContent('git:remotes', git(root, ['remote', '-v']), { runtime: false }));
  }
  return { passed: findings.length === 0, gitRepository: ownGit, historyScanned: ownGit && history, checkedFiles, checkedGitObjects, findings, limitation: 'Pattern scanning cannot prove the absence of all private data. Demo screenshots and realistic fixtures require human provenance review.' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf('--root');
  const root = rootIndex < 0 ? resolve(fileURLToPath(new URL('..', import.meta.url))) : resolve(args[rootIndex + 1]);
  try {
    const result = scanRepository(root);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.passed ? 0 : 1;
  } catch (error) {
    const diagnostic = error.code === 'GIT_ROOT_UNVERIFIED' ? ' Git root verification: ' + error.reason + '.' : '';
    console.error('Security scan could not finish.' + diagnostic + ' Check repository integrity and read permissions. No sensitive match values are printed.');
    process.exitCode = 2;
  }
}
