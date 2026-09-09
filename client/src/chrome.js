/** Google Chrome on desktop. Safari, Firefox, Edge, Opera, Brave, and iOS Chrome are rejected. */
export function isGoogleChrome() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/iPad|iPhone|iPod/.test(ua)) return false;
  if (/Edg\/|EdgiOS|OPR\/|Opera|SamsungBrowser|UCBrowser|YaBrowser/.test(ua)) return false;
  if (navigator.brave) return false;
  return /Chrome\//.test(ua) && !/Chromium\//.test(ua);
}
