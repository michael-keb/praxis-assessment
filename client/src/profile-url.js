const PROFILE_HOSTS = {
  linkedin: ['linkedin.com', 'www.linkedin.com'],
  upwork: ['upwork.com', 'www.upwork.com'],
};

// Accept the domain people paste from their profile, then validate the parsed
// host rather than trusting a URL prefix that could point somewhere else.
export function normalizeProfileUrl(value, provider) {
  const hosts = PROFILE_HOSTS[provider];
  if (!hosts || typeof value !== 'string' || !value || value !== value.trim() || /\s|\\/.test(value)) return null;
  let candidate = value;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    const lower = candidate.toLowerCase();
    if (!hosts.some(host => lower === host || lower.startsWith(`${host}/`))) return null;
    candidate = `https://${candidate}`;
  }
  try {
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol) || !hosts.includes(url.hostname.toLowerCase())) return null;
    if (url.username || url.password || url.port) return null;
    const path = decodeURIComponent(url.pathname);
    if (/\s/.test(path) || !path.split('/').some(segment => /[a-z0-9]/i.test(segment))) return null;
    if (/\s/.test(decodeURIComponent(`${url.search}${url.hash}`))) return null;
    return url.toString();
  } catch {
    return null;
  }
}
