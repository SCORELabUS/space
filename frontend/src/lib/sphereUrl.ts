// Keep the pricing path, but use the SPHERE address reachable by the browser.
export function spherePricingUrl(permanentUrl: string, publicUrl?: string): string {
  if (!publicUrl?.trim()) return permanentUrl;
  const source = new URL(permanentUrl);
  const base = publicUrl.trim().replace(/\/+$/, '') + '/';
  return new URL(source.pathname.replace(/^\/+/, '') + source.search + source.hash, base).href;
}
