// Default import: lz-string is CommonJS, and Node (tests) exposes it only as a default export.
import LZString from 'lz-string';

// Keep the pricing path, but use the SPHERE address reachable by the browser.
export function spherePricingUrl(permanentUrl: string, publicUrl?: string): string {
  if (!publicUrl?.trim()) return permanentUrl;
  const source = new URL(permanentUrl);
  const base = publicUrl.trim().replace(/\/+$/, '') + '/';
  return new URL(source.pathname.replace(/^\/+/, '') + source.search + source.hash, base).href;
}

export const DEFAULT_SPHERE_URL = 'https://sphere.score.us.es';

const SPHERE_ID = /^[a-f\d]{24}$/i;

/**
 * Largest `#pricing=` value SPACE hands to SPHERE's editor: 512 KiB of encoded characters.
 * Browsers accept far longer URLs (Chromium 2 MiB, Firefox about 1 MiB); the largest real
 * pricing measured (53,107 bytes of YAML) encodes to 19,766 characters.
 */
export const SPHERE_FRAGMENT_MAX_ENCODED = 512 * 1024;

/**
 * Whether the configured SPHERE's editor reads a pricing from `#pricing=` (build setting
 * `SPHERE_EDITOR_FRAGMENT`). Off unless it is exactly `true`: an editor without that support
 * ignores the fragment and shows its default template instead of the user's pricing.
 */
export function sphereEditorFragmentEnabled(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'true';
}

/** The fields of a SPACE pricing that say where SPHERE can open it. */
export interface SphereViewSource {
  /** Set when the pricing is defined by a remote URL instead of a file stored by SPACE. */
  url?: string;
  /** Set on snapshots imported from SPHERE. */
  sphere?: { pricingId?: string; versionId?: string; permanentUrl?: string };
  /** Set when SPACE stores the pricing file (uploaded by hand, or a SPHERE snapshot). */
  yamlPath?: string;
}

export interface SphereViewOptions {
  /** SPHERE's editor reads `#pricing=` (see `sphereEditorFragmentEnabled`). */
  editorFragment?: boolean;
}

export type SphereViewLink =
  /** SPHERE's permanent link for the pricing: SPHERE resolves it and applies its own permissions. */
  | { kind: 'permalink'; url: string }
  /** SPHERE's editor, loading a pricing that is published at an external URL. */
  | { kind: 'editor'; url: string }
  /**
   * SPHERE's editor, for a pricing file stored by SPACE. `url` has no query or fragment: the
   * caller reads the YAML with the user's credentials and adds it with `sphereEditorContentUrl`.
   */
  | { kind: 'content'; url: string };

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
 * - Snapshot of a SPHERE pricing: SPHERE's permanent link `/p/{pricingId}?version={versionId}`,
 *   on the SPHERE version SPACE copied. Without a valid version ID: `/p/{pricingId}`. A SPHERE
 *   without version links ignores `version` and opens its latest version.
 * - Pricing defined by an external URL: SPHERE's editor fetches that URL itself.
 * - Pricing file stored by SPACE (uploaded by hand), when SPHERE's editor reads `#pricing=`:
 *   SPHERE's editor, to be given the content in the URL fragment. Its YAML is only readable
 *   with the organization's credentials, so SPHERE cannot fetch it; browsers never send the
 *   fragment to a server. Without that editor support: `null`.
 */
export function sphereViewLink(
  pricing: SphereViewSource,
  publicUrl?: string,
  options: SphereViewOptions = {}
): SphereViewLink | null {
  const browserUrl = httpUrl(publicUrl)?.href;
  const base = (browserUrl ?? DEFAULT_SPHERE_URL).replace(/\/+$/, '') + '/';
  const pricingId = pricing.sphere?.pricingId?.trim().toLowerCase();

  if (pricingId && SPHERE_ID.test(pricingId)) {
    const permanent = httpUrl(pricing.sphere?.permanentUrl);
    const url = new URL(
      permanent && permanent.pathname.replace(/\/+$/, '').toLowerCase().endsWith(`/p/${pricingId}`)
        ? spherePricingUrl(permanent.href, browserUrl)
        : new URL(`p/${pricingId}`, base).href
    );
    // SPHERE's version `_id`, the value its permanent links take in `?version=`.
    const versionId = pricing.sphere?.versionId?.trim().toLowerCase();
    if (versionId && SPHERE_ID.test(versionId)) {
      url.searchParams.set('version', versionId);
    }
    return { kind: 'permalink', url: url.href };
  }

  const remote = httpUrl(pricing.url);
  if (remote) {
    const editor = new URL('editor', base);
    editor.searchParams.set('pricingUrl', remote.href);
    return { kind: 'editor', url: editor.href };
  }

  if (options.editorFragment && pricing.yamlPath?.trim()) {
    return { kind: 'content', url: new URL('editor', base).href };
  }

  return null;
}

export type SphereContentUrl =
  | { ok: true; url: string; encodedLength: number }
  | { ok: false; reason: 'empty' }
  | { ok: false; reason: 'too-large'; encodedLength: number; maxEncodedLength: number };

/**
 * SPHERE's editor URL carrying an already encoded pricing in its fragment:
 * `<editor>#pricing=<encoded>`. The fragment is the only place the content goes: never the
 * query string, which reaches SPHERE's servers and their logs. A value longer than
 * `maxEncodedLength` is refused, never truncated.
 */
export function sphereEditorFragmentUrl(
  editorUrl: string,
  encoded: string,
  maxEncodedLength: number = SPHERE_FRAGMENT_MAX_ENCODED
): SphereContentUrl {
  if (!encoded) {
    return { ok: false, reason: 'empty' };
  }
  if (encoded.length > maxEncodedLength) {
    return { ok: false, reason: 'too-large', encodedLength: encoded.length, maxEncodedLength };
  }
  const editor = new URL(editorUrl);
  editor.search = '';
  editor.hash = '';
  return { ok: true, url: `${editor.href}#pricing=${encoded}`, encodedLength: encoded.length };
}

/**
 * SPHERE's editor URL carrying a pricing YAML in its fragment, encoded like SPHERE's own share
 * links (lz-string `compressToEncodedURIComponent`). See `sphereEditorFragmentUrl`.
 */
export function sphereEditorContentUrl(
  editorUrl: string,
  yaml: string,
  maxEncodedLength: number = SPHERE_FRAGMENT_MAX_ENCODED
): SphereContentUrl {
  if (!yaml.trim()) {
    return { ok: false, reason: 'empty' };
  }
  return sphereEditorFragmentUrl(editorUrl, LZString.compressToEncodedURIComponent(yaml), maxEncodedLength);
}
