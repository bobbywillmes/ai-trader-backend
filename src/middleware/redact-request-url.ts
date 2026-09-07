export function redactSensitiveRequestUrl(url?: string) {
  if (!url) return url;
  // Drop the complete ingress suffix, including any query string or extra path.
  // Match Express's default case-insensitive routing and encoded path separators.
  let decoded: string;
  try { decoded = decodeURIComponent(url); } catch { decoded = url; }
  if (/\/api\/external-signals(?:\/|\?|$)/i.test(decoded)) return '/api/external-signals/[redacted]';
  return url.replace(/(\/api\/auth\/setup\/)[^/?#]+/gi, '$1[redacted]');
}
