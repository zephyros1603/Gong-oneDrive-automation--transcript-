export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { sseResponse } from '@/core/http.js';
import { subscribe, unreadCount } from '@/core/notify.js';

/**
 * The live half of notifications. No replay of history here — `GET
 * /api/notifications` is what a page reads on load; this is only for
 * "something happened while you were looking at this tab."
 */
export async function GET(req) {
  return sseResponse((stream) => {
    stream.send({ type: 'hello', unread: unreadCount() });
    const off = subscribe((n) => stream.send({ type: 'notification', notification: n }));
    stream.onCancel(() => off());
  });
}
