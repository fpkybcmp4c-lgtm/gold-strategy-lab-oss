import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function running(pid) { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } }
export function acquireDataLock(directory) {
  // A sibling lock survives an atomic replacement of the data directory.
  const file = directory + '.lock', token = randomUUID();
  mkdirSync(path.dirname(file), {recursive: true});
  function save(childPid) { writeFileSync(file, JSON.stringify({pid: process.pid, childPid, token}), {flag: 'wx', mode: 0o600}); }
  for (let attempt = 0; attempt < 2; attempt++) {
    try { save(); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let info; try { info = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error('数据锁无法读取，请先确认没有运行中的服务：' + file); }
      if (running(info.pid) || running(info.childPid)) throw new Error('数据正在使用中。请先停止服务或其他数据维护命令。');
      rmSync(file);
      if (attempt === 1) throw new Error('无法取得数据锁。');
    }
  }
  return {
    setChild(pid) { writeFileSync(file, JSON.stringify({pid: process.pid, childPid: pid, token}), {mode: 0o600}); },
    release() { if (existsSync(file)) { const info = JSON.parse(readFileSync(file, 'utf8')); if (info.token === token) rmSync(file); } },
  };
}
