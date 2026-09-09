const PROFILE_HOSTS = Object.freeze({
  linkedin: new Set(["linkedin.com", "www.linkedin.com"]),
  upwork: new Set(["upwork.com", "www.upwork.com"]),
});

function hasMeaningfulPath(url) {
  let decoded;
  try { decoded = decodeURIComponent(url.pathname); }
  catch { return false; }
  if (/\s/.test(decoded)) return false;
  return decoded.split("/").some((segment) => /[a-z0-9]/i.test(segment));
}

/**
 * Normalize a candidate profile URL without permitting URL-parser host tricks.
 * Bare expected-domain inputs receive https://; everything else must already
 * be an HTTP(S) URL. Returns null when the value is not a safe profile URL.
 */
export function normalizeProfileUrl(value, provider) {
  const hosts = PROFILE_HOSTS[provider];
  if (!hosts || typeof value !== "string" || !value) return null;
  if (value !== value.trim() || /\s|\\/.test(value)) return null;

  let candidate = value;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    const lower = candidate.toLowerCase();
    if (![...hosts].some((host) => lower === host || lower.startsWith(`${host}/`))) return null;
    candidate = `https://${candidate}`;
  }

  let url;
  try { url = new URL(candidate); }
  catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!hosts.has(url.hostname.toLowerCase())) return null;
  if (url.username || url.password || url.port) return null;
  if (!hasMeaningfulPath(url)) return null;
  try {
    if (/\s/.test(decodeURIComponent(`${url.search}${url.hash}`))) return null;
  } catch {
    return null;
  }
  return url.toString();
}

export function normalizeLinkedInUrl(value) {
  return normalizeProfileUrl(value, "linkedin");
}

export function normalizeUpworkUrl(value) {
  return normalizeProfileUrl(value, "upwork");
}
