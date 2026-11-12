// Bearer credentials may travel over plain HTTP only for local development.
export function serviceUrl(value: string): string {
  const url = new URL(value);
  const loopbackHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((!loopbackHttp && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) {
    throw new Error('Configure an HTTPS service URL without credentials, query, or fragment. HTTP is supported on localhost.');
  }
  return url.href.replace(/\/$/, '');
}
