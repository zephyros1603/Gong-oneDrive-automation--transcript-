'use client';

/**
 * lib/useWidgetLayout.js — which dashboard widgets show, and in what order.
 *
 * Drag-and-drop via the native HTML5 API rather than a library: the whole
 * interaction is reorder-within-one-list, and dnd-kit or react-beautiful-dnd
 * would be ~40KB for something four handlers cover.
 *
 * The layout is per-viewer and cosmetic, so localStorage is the right home and
 * a failure to read it is ignored rather than handled.
 */

import { useCallback, useEffect, useState } from 'react';

const KEY = 'warp.dashboard.layout';

export function useWidgetLayout(defaults) {
  const [order, setOrder] = useState(defaults.map((w) => w.id));
  const [hidden, setHidden] = useState([]);
  const [editing, setEditing] = useState(false);
  const [dragging, setDragging] = useState(null);
  const [over, setOver] = useState(null);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (!saved) return;
      // Reconcile with the current widget set, or a widget added in a later
      // release never appears for anyone who has saved a layout.
      const known = defaults.map((w) => w.id);
      const kept = (saved.order || []).filter((id) => known.includes(id));
      const added = known.filter((id) => !kept.includes(id));
      setOrder([...kept, ...added]);
      setHidden((saved.hidden || []).filter((id) => known.includes(id)));
    } catch { /* cosmetic state; not worth reporting */ }
  }, [defaults]);

  const persist = useCallback((nextOrder, nextHidden) => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ order: nextOrder, hidden: nextHidden }));
    } catch { /* private window */ }
  }, []);

  const move = useCallback((from, to) => {
    setOrder((cur) => {
      const next = [...cur];
      next.splice(to, 0, next.splice(from, 1)[0]);
      persist(next, hidden);
      return next;
    });
  }, [hidden, persist]);

  const toggle = useCallback((id) => {
    setHidden((cur) => {
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      persist(order, next);
      return next;
    });
  }, [order, persist]);

  const reset = useCallback(() => {
    const next = defaults.map((w) => w.id);
    setOrder(next);
    setHidden([]);
    persist(next, []);
  }, [defaults, persist]);

  /** Spread onto each widget wrapper while editing. */
  const dragProps = useCallback((id) => ({
    draggable: editing,
    onDragStart: () => setDragging(id),
    onDragEnd: () => { setDragging(null); setOver(null); },
    onDragOver: (e) => {
      if (!dragging || dragging === id) return;
      e.preventDefault();
      setOver(id);
    },
    onDrop: (e) => {
      e.preventDefault();
      if (!dragging || dragging === id) return;
      move(order.indexOf(dragging), order.indexOf(id));
      setDragging(null);
      setOver(null);
    },
  }), [editing, dragging, order, move]);

  return {
    order, hidden, editing, setEditing, dragging, over,
    visible: order.filter((id) => !hidden.includes(id)),
    toggle, reset, dragProps,
  };
}
