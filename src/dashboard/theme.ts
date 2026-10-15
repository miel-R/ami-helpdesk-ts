// Theme (light/dark) persistence.
//
// The toggle used to flip `data-bs-theme` and nothing else, so the choice was
// forgotten on reload and the button icon never changed to reflect state. This
// keeps the choice in localStorage, applies it before first paint, and keeps the
// button honest about what it will do next.
//
// The inline snippet in index.html calls `applyStoredTheme()` on purpose. It has
// to run before the body paints, otherwise a dark-mode admin sees a white flash
// on every navigation while the module is still being fetched. That one call is
// the only reason this file has an export at all - see applyStoredTheme below for
// why the CSP does not stop it.

const KEY = 'ami.dashboard.theme';

export type Theme = 'light' | 'dark';

export function storedTheme(): Theme {
  try {
    return window.localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    // Private mode / disabled storage: fall back to whatever Bootstrap defaults to.
    return document.documentElement.dataset.bsTheme === 'dark' ? 'dark' : 'light';
  }
}

function currentTheme(): Theme {
  return document.documentElement.dataset.bsTheme === 'dark' ? 'dark' : 'light';
}

/**
 * Apply the stored theme. Called from an inline script in <head> before paint.
 *
 * CSP note: helmet serves `script-src 'self'` with no 'unsafe-inline', so the
 * inline snippet cannot execute. It is therefore intentionally NOT used, and
 * this export is what the client module calls on load instead. The residual flash
 * on a hard reload is accepted; correctness beats a one-line inline hack that
 * would be silently blocked.
 */
export function applyStoredTheme(): void {
  document.documentElement.dataset.bsTheme = storedTheme();
  syncButton();
}

function syncButton(): void {
  const btn = document.getElementById('themeBtn');
  if (!btn) return;
  const dark = currentTheme() === 'dark';
  // The icon advertises what clicking will DO, not what is currently active.
  const icon = btn.querySelector('i');
  if (icon) icon.className = dark ? 'bi bi-brightness-high' : 'bi bi-moon-stars';
  btn.setAttribute('aria-pressed', String(dark));
  btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  btn.setAttribute('title', dark ? 'Switch to light theme' : 'Switch to dark theme');
}

export function toggleTheme(): void {
  const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.bsTheme = next;
  try {
    window.localStorage.setItem(KEY, next);
  } catch {
    // Nothing useful to do; the toggle still works for this page view.
  }
  syncButton();
}