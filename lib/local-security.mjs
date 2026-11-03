/** The standalone edition is accessed through loopback, including SSH tunnels. */
export function localRequestAllowed(request) {
  const url = new URL(request.url), host = request.headers.get('host') || url.host;
  const expected = new Set(['127.0.0.1', 'localhost', '[::1]'].map(name => name + (url.port ? ':' + url.port : '')));
  if (!expected.has(url.host) || !expected.has(host)) return false;
  if (request.headers.get('x-forwarded-host') && request.headers.get('x-forwarded-host') !== host) return false;
  const origin = request.headers.get('origin');
  if (origin && origin !== url.protocol + '//' + host) return false;
  if (request.headers.get('sec-fetch-site') === 'cross-site') return false;
  return true;
}
