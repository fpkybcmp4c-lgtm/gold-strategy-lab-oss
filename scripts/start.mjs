import http from 'node:http';
import { createRequire } from 'node:module';
import { dataDirectory, loadEnvironment, openLocalStorage } from '../lib/local-storage.mjs';
import { localRequestAllowed } from '../lib/local-security.mjs';
import { acquireDataLock } from './data-lock.mjs';

loadEnvironment();
process.env.NEXT_TELEMETRY_DISABLED = '1';
const portText = process.env.PORT || '3000';
if (!/^\d+$/.test(portText) || Number(portText) < 1024 || Number(portText) > 65535) throw new Error('PORT 必须是1024至65535的整数。');
const port = Number(portText), directory = dataDirectory(), lock = acquireDataLock(directory);
// Keep Next's later environment loading aligned with the directory protected by this lock.
process.env.DATA_DIR = directory;
process.env.PORT = String(port);
process.once('exit', () => lock.release());
try { openLocalStorage(directory).close(); } catch (error) { lock.release(); throw error; }
const require = createRequire(import.meta.url), next = require('next');
const app = next({dev: process.argv.includes('--dev'), hostname: '127.0.0.1', port});
try { await app.prepare(); } catch (error) { lock.release(); throw error; }
const handle = app.getRequestHandler();
const server = http.createServer((request, response) => {
  try {
    if (!request.headers.host || !request.url?.startsWith('/')) throw new Error('Invalid request');
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(',') : value);
    const url = new URL(request.url, 'http://' + request.headers.host);
    // A network-path request target must not replace the actual Host authority.
    if (url.host !== request.headers.host || !localRequestAllowed(new Request(url, {headers}))) throw new Error('Invalid origin');
  } catch {
    response.writeHead(403, {'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8'});
    response.end('仅支持本机同源访问。');
    return;
  }
  handle(request, response);
});
server.headersTimeout = 20000;
server.requestTimeout = 60000;
let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  const timeout = setTimeout(() => server.closeAllConnections(), 10000);
  timeout.unref();
  server.close(async () => {
    clearTimeout(timeout);
    await app.close();
    lock.release();
    process.exit(0);
  });
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('message', message => { if (message === 'stop') void stop(); });
server.once('error', async error => { console.error(error.message); await app.close(); lock.release(); process.exit(1); });
server.listen(port, '127.0.0.1', () => console.log('个人策略验证已启动：http://127.0.0.1:' + port));
