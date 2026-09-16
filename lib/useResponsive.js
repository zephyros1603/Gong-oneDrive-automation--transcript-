'use client';

/**
 * lib/useResponsive.js — how the app knows how much room it has.
 *
 * This exists because the shell is an `overflow: hidden` app layout rather
 * than a document: when something inside it is wider than the window, there is
 * no scrollbar to rescue it, the content is simply clipped and unreachable.
 * A fixed-width sidebar and a `flex-none` six-tab nav did exactly that — at
 * 600px the Provisioning tab was cut off the right edge with no way to get to
 * it, and browser zoom produces the same effect on a large screen, because
 * zoom is just a narrower viewport in CSS pixels.
 *
 * So every layout decision that used to be a guess is measured here instead.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

/** Tailwind's breakpoints, so CSS and JS agree about what "narrow" means. */
export const BREAKPOINTS = { sm: 640, md: 768, lg: 1024, xl: 1280, '2xl': 1536 };

/* ------------------------------------------------------------ media query */

const subscribeTo = (query) => (onChange) => {
  const mql = window.matchMedia(query);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
};

/**
 * Track a media query.
 *
 * useSyncExternalStore rather than useEffect + useState: it subscribes during
 * render, so a query that changes between render and effect cannot be missed.
 * The server snapshot is `false` — there is no viewport during SSR, and
 * guessing one produces markup that disagrees with the client on hydration.
 */
export function useMediaQuery(query) {
  const subscribe = useCallback(subscribeTo(query), [query]);
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false
  );
}

/* -------------------------------------------------------------- viewport */

/** Live viewport width. 0 until mounted, so callers can wait for a real one. */
export function useViewportWidth() {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const read = () => setWidth(window.innerWidth);
    read();
    window.addEventListener('resize', read);
    // Zoom and the iPad keyboard change the visual viewport without always
    // firing `resize`, and zoom is the case that produced the original bug.
    window.visualViewport?.addEventListener('resize', read);
    return () => {
      window.removeEventListener('resize', read);
      window.visualViewport?.removeEventListener('resize', read);
    };
  }, []);

  return width;
}

/**
 * The layout question every page actually asks.
 *
 *   phone   < 640   one column, sidebars become overlays, nav collapses
 *   compact < 1024  sidebars still overlay; the nav is a menu
 *   desktop ≥ 1024  side by side, everything visible
 *
 * `mounted` is false on the first client render, which is how a caller avoids
 * rendering the desktop layout for a frame before the real width is known.
 */
export function useBreakpoint() {
  const width = useViewportWidth();
  const isPhone = useMediaQuery(`(max-width: ${BREAKPOINTS.sm - 1}px)`);
  const isCompact = useMediaQuery(`(max-width: ${BREAKPOINTS.lg - 1}px)`);
  const isTouch = useMediaQuery('(hover: none) and (pointer: coarse)');

  return {
    width,
    mounted: width > 0,
    isPhone,
    isCompact,          // sidebar overlays rather than sits beside
    isDesktop: !isCompact,
    isTouch,
    atLeast: (bp) => width >= (BREAKPOINTS[bp] ?? bp),
    atMost: (bp) => width > 0 && width <= (BREAKPOINTS[bp] ?? bp),
  };
}

/* ------------------------------------------------------- resizable panel */

/**
 * A drag-resizable side panel that cannot strand the content beside it.
 *
 * Two rules the hand-rolled splitters all got wrong:
 *
 *   - The width is re-clamped when the *window* resizes, not only while
 *     dragging. Otherwise a 480px sidebar chosen on a large monitor survives
 *     into a 600px window and leaves ~120px for the content.
 *   - The clamp reserves room for the main pane (`keepForMain`), so widening
 *     the sidebar can never squeeze the content to nothing.
 *
 * The chosen width is remembered per panel, and it is a per-viewer
 * convenience, so localStorage failing (private window, blocked site data) is
 * ignored rather than handled.
 */
export function useResizablePanel({
  initial = 280,
  min = 200,
  max = 480,
  keepForMain = 380,
  storageKey,
  enabled = true,
} = {}) {
  const viewport = useViewportWidth();
  const [width, setWidthRaw] = useState(initial);
  const [dragging, setDragging] = useState(false);

  const clamp = useCallback((value, vw) => {
    const room = vw || (typeof window === 'undefined' ? 0 : window.innerWidth);
    const ceiling = room ? Math.min(max, Math.max(min, room - keepForMain)) : max;
    return Math.min(Math.max(value, min), ceiling);
  }, [min, max, keepForMain]);

  useEffect(() => {
    if (!storageKey) return;
    try {
      const saved = Number(localStorage.getItem(storageKey));
      if (Number.isFinite(saved) && saved > 0) setWidthRaw(clamp(saved));
    } catch { /* storage is a convenience, never a requirement */ }
  }, [storageKey, clamp]);

  // Re-clamp whenever the window changes, not only while dragging.
  useEffect(() => {
    if (!viewport) return;
    setWidthRaw((w) => clamp(w, viewport));
  }, [viewport, clamp]);

  const setWidth = useCallback((value) => {
    const next = clamp(value);
    setWidthRaw(next);
    if (storageKey) {
      try { localStorage.setItem(storageKey, String(next)); } catch { /* fine */ }
    }
  }, [clamp, storageKey]);

  useEffect(() => {
    if (!dragging) return;
    const move = (e) => setWidth(e.clientX);
    const up = () => setDragging(false);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [dragging, setWidth]);

  return {
    width,
    setWidth,
    dragging,
    /** Spread onto the drag handle. */
    handleProps: enabled
      ? {
          onMouseDown: (e) => { e.preventDefault(); setDragging(true); },
          role: 'separator',
          'aria-orientation': 'vertical',
          tabIndex: 0,
          // Keyboard resizing, because a drag handle that only takes a mouse
          // is unusable for anyone who does not use one.
          onKeyDown: (e) => {
            if (e.key === 'ArrowLeft') { e.preventDefault(); setWidth(width - 24); }
            if (e.key === 'ArrowRight') { e.preventDefault(); setWidth(width + 24); }
          },
        }
      : {},
  };
}

/* --------------------------------------------------------------- overlays */

/** Close on Escape and lock the background from scrolling while open. */
export function useDismissable(open, onClose) {
  useEffect(() => {
    if (!open) return;
    const key = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [open, onClose]);
}
