export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json, fail, readBody } from '@/core/http.js';
import { listSchedules, saveSchedule, deleteSchedule } from '@/core/workflow/store.js';
import { scheduleState } from '@/core/workflow/scheduler.js';

export async function GET() {
  return json({ schedules: listSchedules().map((s) => ({ ...s, ...scheduleState(s) })) });
}

export async function POST(req) {
  const body = await readBody(req);
  try {
    if (body.delete) return json({ deleted: deleteSchedule(body.delete) });
    return json({ schedule: saveSchedule(body) });
  } catch (err) {
    return fail(err);
  }
}
