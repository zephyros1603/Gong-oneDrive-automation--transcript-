'use client';

/**
 * components/ThemeToggle.jsx — light/dark, without a theme library.
 *
 * shadcn's convention is a `.dark` class on <html>, which is a class toggle
 * rather than a media query — that is what makes a real user-facing switch
 * possible at all. `next-themes` does this too, but it costs a dependency and
 * a provider for what is thirty lines, and the only shadcn component that
 * actually needs it (sonner) is not installed.
 *
 * The flash-of-wrong-theme is handled by `themeScript` below, which runs
 * before first paint — see app/layout.jsx.
 */

import { useEffect, useState } from 'react';
import { Sun, Moon } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';

const KEY = 'warp.theme';

/**
 * Inlined into <head> and executed before React hydrates. Anything slower
 * than this paints the light theme first and then snaps to dark, which looks
 * broken every single reload.
 */
export const themeScript = `
(function () {
  try {
    // Light is the default, not the OS preference. The design is authored
    // light-first, and falling back to prefers-color-scheme means a dark-mode
    // machine never sees it. Once toggled, the choice is remembered.
    if (localStorage.getItem('${KEY}') === 'dark') {
      document.documentElement.classList.add('dark');
    }
  } catch (e) {}
})();
`;

export default function ThemeToggle() {
  const [dark, setDark] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains('dark'));
    setReady(true);
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    try { localStorage.setItem(KEY, next ? 'dark' : 'light'); } catch { /* private window */ }
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggle}
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      title={dark ? 'Light theme' : 'Dark theme'}
      className="rounded-xl text-muted-foreground hover:text-foreground"
    >
      {/* Render nothing until mounted, or the server's guess flashes. */}
      {ready && (dark
        ? <Sun size={17} weight="duotone" />
        : <Moon size={17} weight="duotone" />)}
    </Button>
  );
}
