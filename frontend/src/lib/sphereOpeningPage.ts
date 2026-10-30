/** Title of the tab while SPACE reads an uploaded pricing before opening it in SPHERE. */
export const SPHERE_OPENING_TITLE = 'Opening in SPHERE…';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
:root { color-scheme: light dark; }
body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: #f9fafb; color: #374151; }
main { display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 16px; text-align: center; }
.spinner { width: 36px; height: 36px; border-radius: 50%; border: 4px solid #e0e7ff; border-top-color: #4f46e5;
  animation: spin 0.8s linear infinite; }
p { margin: 0; font-size: 15px; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-color-scheme: dark) {
  body { background: #111827; color: #e5e7eb; }
  .spinner { border-color: #312e81; border-top-color: #a5b4fc; }
}
@media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
`;

/**
 * The page written into the blank tab that "View in SPHERE" opens during the click, shown while
 * SPACE reads the uploaded pricing's YAML. It is self-contained: inline CSS, no script and no
 * resource to load, and the version is escaped so it is only ever text. The result is the
 * content of `<html>` (its `<head>` and `<body>`).
 */
export function sphereOpeningPage(version: string): string {
  const label = version.trim() ? `pricing <strong>${escapeHtml(version.trim())}</strong>` : 'the pricing';
  return (
    `<head><meta charset="utf-8"><title>${SPHERE_OPENING_TITLE}</title><style>${STYLE}</style></head>` +
    `<body><main role="status" aria-live="polite"><div class="spinner" aria-hidden="true"></div>` +
    `<p>Opening ${label} in SPHERE…</p></main></body>`
  );
}
