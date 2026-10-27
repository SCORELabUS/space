// Keep the pricing path, but use the SPHERE address reachable by the browser.
export function spherePricingUrl(permanentUrl: string, publicUrl?: string): string {
  if (!publicUrl?.trim()) return permanentUrl;
  const source = new URL(permanentUrl);
  const base = publicUrl.trim().replace(/\/+$/, '') + '/';
  return new URL(source.pathname.replace(/^\/+/, '') + source.search + source.hash, base).href;
}

export const DEFAULT_SPHERE_URL = 'https://sphere.score.us.es';

const SPHERE_ID = /^[a-f\d]{24}$/i;

/** The fields of a SPACE pricing that say where SPHERE can open it. */
export interface SphereViewSource {
  /** Set when the pricing is defined by a remote URL instead of a file stored by SPACE. */
  url?: string;
  /** Set on snapshots imported from SPHERE. */
  sphere?: { pricingId?: string; permanentUrl?: string };
}

export type SphereViewLink =
  /** SPHERE's permanent link for the pricing: SPHERE resolves it and applies its own permissions. */
  | { kind: 'permalink'; url: string }
  /** SPHERE's editor, loading a pricing that is published at an external URL. */
  | { kind: 'editor'; url: string };

function httpUrl(value: string | undefined): URL | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * Where "View in SPHERE" opens a pricing version, or `null` when SPHERE cannot open it.
 *
 * - Snapshot of a SPHERE pricing: SPHERE's permanent link `/p/{pricingId}`. SPHERE has no
 *   link to a single version, so its pricing page opens on its latest version.
 * - Pricing defined by an external URL: SPHERE's editor fetches that URL itself.
 * - Pricing file stored by SPACE (uploaded by hand): `null`. Its YAML is only readable with
 *   the organization's credentials, and SPHERE has no way to receive its content that fits
 *   every pricing without copying it into a URL.
 */
export function sphereViewLink(pricing: SphereViewSource, publicUrl?: string): SphereViewLink | null {
  const browserUrl = httpUrl(publicUrl)?.href;
  const base = (browserUrl ?? DEFAULT_SPHERE_URL).replace(/\/+$/, '') + '/';
  const pricingId = pricing.sphere?.pricingId?.trim().toLowerCase();

  if (pricingId && SPHERE_ID.test(pricingId)) {
    const permanent = httpUrl(pricing.sphere?.permanentUrl);
    const url =
      permanent && permanent.pathname.replace(/\/+$/, '').toLowerCase().endsWith(`/p/${pricingId}`)
        ? spherePricingUrl(permanent.href, browserUrl)
        : new URL(`p/${pricingId}`, base).href;
    return { kind: 'permalink', url };
  }

  const remote = httpUrl(pricing.url);
  if (remote) {
    const editor = new URL('editor', base);
    editor.searchParams.set('pricingUrl', remote.href);
    return { kind: 'editor', url: editor.href };
  }

  return null;
}
