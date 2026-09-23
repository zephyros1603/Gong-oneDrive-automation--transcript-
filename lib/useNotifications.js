'use client';

/**
 * lib/useNotifications.js — the bell icon's data, in one hook.
 *
 * Two sources, deliberately: an initial `GET` for what happened while the
 * page was closed, then `EventSource` for what happens while it is open.
 * `EventSource`, not the manual fetch+reader `useRunStream` uses, because
 * there is no per-run id to attach to and no cancel semantics to get right —
 * it is exactly the case the browser's own reconnecting client covers well.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const MAX_TOASTS = 4;
const TOAST_MS = 6000;

export function useNotifications() {
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [toasts, setToasts] = useState([]);
  const toastTimer = useRef(new Map());

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/notifications').then((x) => x.json());
      setItems(r.notifications || []);
      setUnread(r.unread || 0);
    } catch { /* the bell just stays at whatever it last knew */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const es = new EventSource('/api/notifications/stream');

    es.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.type === 'hello') { setUnread(msg.unread || 0); return; }
      if (msg.type !== 'notification') return;

      const n = msg.notification;
      setItems((cur) => [n, ...cur].slice(0, 50));
      setUnread((c) => c + 1);

      setToasts((cur) => [n, ...cur].slice(0, MAX_TOASTS));
      const t = setTimeout(() => {
        setToasts((cur) => cur.filter((x) => x.id !== n.id));
        toastTimer.current.delete(n.id);
      }, TOAST_MS);
      toastTimer.current.set(n.id, t);

      // A tab in the background is exactly the case a person asked for this
      // to cover — "so the user isn't alarmed" means they find out *before*
      // switching back, not only after. Silently does nothing without
      // permission; this never itself prompts for it.
      if (document.hidden && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try { new Notification(n.title, { body: n.body, tag: n.id }); } catch { /* best effort */ }
      }
    };

    // The browser retries on its own; nothing to do here but let it.
    es.onerror = () => {};

    return () => {
      es.close();
      for (const t of toastTimer.current.values()) clearTimeout(t);
      toastTimer.current.clear();
    };
  }, []);

  const dismissToast = useCallback((id) => {
    setToasts((cur) => cur.filter((x) => x.id !== id));
    const t = toastTimer.current.get(id);
    if (t) { clearTimeout(t); toastTimer.current.delete(id); }
  }, []);

  const markRead = useCallback(async (id) => {
    setItems((cur) => cur.map((n) => (n.id === id ? { ...n, read: true } : n)));
    setUnread((c) => Math.max(0, c - 1));
    await fetch('/api/notifications', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    });
  }, []);

  const markAllRead = useCallback(async () => {
    setItems((cur) => cur.map((n) => ({ ...n, read: true })));
    setUnread(0);
    await fetch('/api/notifications', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ all: true }),
    });
  }, []);

  /** Ask once, on a click — never on mount, which browsers ignore anyway. */
  const requestPermission = useCallback(() => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, []);

  return { items, unread, toasts, dismissToast, markRead, markAllRead, requestPermission };
}
