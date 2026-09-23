export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json, readBody } from '@/core/http.js';
import { list, unreadCount, markRead, markAllRead } from '@/core/notify.js';

export async function GET(req) {
  const url = new URL(req.url);
  const unreadOnly = url.searchParams.get('unread') === '1';
  const limit = Number(url.searchParams.get('limit')) || 50;
  return json({ notifications: list({ limit, unreadOnly }), unread: unreadCount() });
}

/** `{ id }` marks one read; `{ all: true }` marks everything read. */
export async function POST(req) {
  const body = await readBody(req);
  if (body.all) markAllRead();
  else if (body.id) markRead(body.id);
  return json({ unread: unreadCount() });
}
