# SPACE interface design

## Visual language
Preserve the existing operational dashboard style: indigo accents, white and gray surfaces, clear sans-serif typography and restrained motion. Do not import SPHERE's orange palette or replace the application's typography.

## Palette and hierarchy
- Primary actions: `bg-indigo-600 text-white`, hover `bg-indigo-700`, dark hover `bg-indigo-800`.
- Headings: `text-indigo-700 dark:text-gray-100`; modal titles `text-xl font-bold`.
- Body: `text-gray-600 dark:text-gray-300`; secondary details `text-sm`.
- Surfaces: `bg-white dark:bg-gray-900`; borders `border-indigo-100 dark:border-gray-800`.
- Secondary actions: `bg-gray-200 dark:bg-gray-800 text-gray-700 dark:text-gray-200`.
- Warnings: amber surface and text with explicit dark variants; errors use red equivalents and a readable message, never color alone.

## Components
Use `AddServiceModal`, `FileOrUrlInput`, `FormError`, `CustomAlert`, and the service detail page as references. Reuse API functions under `frontend/src/api`. Shared additions belong in `components`; service-specific additions may use `components/services`.

Modals use a dimmed overlay (`bg-black/30 dark:bg-black/60`), `rounded-2xl`, `shadow-2xl`, a subtle border and `p-6 sm:p-8`. Constrain height and allow internal scrolling on small screens. Existing motion uses a short opacity/scale transition; respect reduced motion. Keep primary and secondary actions together and clearly named.

Forms have persistent labels, full-width inputs, readable helper text and errors linked to fields. Use indigo focus rings, gray/white input backgrounds and matching dark variants. Reserve vertical space for informative state rather than changing button labels without context. Disable repeated submissions while pending. All clickable controls require `cursor-pointer`.

Cards use a light border, rounded corners and consistent gaps (`gap-3`, `gap-4`, `space-y-4`). Present status with a text badge and timestamp. Tables must remain readable through horizontal scrolling or stacked details on narrow screens. Empty and unavailable states explain what happened and the next available action.

## Accessibility and responsive behavior
Use semantic buttons, links, labels and dialog headings. Show keyboard focus; dialogs support Escape, focus containment and restoring focus to their trigger. Announce asynchronous results using an appropriate live region. Avoid hover-only information. Use single-column forms on mobile and only introduce columns where space permits. Touch controls should be at least 44px high.

## Synchronization UI
Source selection distinguishes file, YAML URL and SPHERE. Explain public-only access next to the permanent-link input. Show the resolved pricing before submission. Always display the fallback warning for All policies. Show applied target, retained versions, last check, last success, progress and actionable errors; do not claim success while migration is incomplete.
