export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json, fail, readBody } from '@/core/http.js';
import * as runs from '@/runs.js';
import { startChatRun } from '@/core/chat.js';

export async function GET(req) {
  const projectId = new URL(req.url).searchParams.get('projectId');
  return json({ runs: runs.list(projectId ? { projectId } : {}) });
}

export async function POST(req) {
  try {
    return json(await startChatRun(await readBody(req)));
  } catch (err) {
    return fail(err);
  }
}
