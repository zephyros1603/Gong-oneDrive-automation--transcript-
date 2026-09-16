export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json, fail, readBody } from '@/core/http.js';
import { listSkills, addSkill, claudeBin } from '@/claude-runner.js';
import { readSettings, writeSettings } from '@/settings.js';

export async function GET() {
  const skills = listSkills();
  const names = new Set(skills.map((s) => s.name));
  return json({
    cli: claudeBin(),
    skills,
    // An action whose skill is not installed is a blueprint: the button still
    // shows, but says so rather than failing at run time.
    actions: readSettings().actions.map((a) => ({ ...a, installed: names.has(a.skill) })),
  });
}

export async function POST(req) {
  const body = await readBody(req);
  try {
    const made = addSkill(body);

    // Adding a skill almost always means wanting a button for it.
    if (body.addButton !== false) {
      const current = readSettings();
      const id = made.dir;
      writeSettings({
        actions: [
          ...current.actions.filter((a) => a.id !== id),
          {
            id,
            label: String(body.label || body.name || id).slice(0, 18),
            title: String(body.description || '').slice(0, 120),
            skill: made.name,
            instruction: body.instruction || `run the ${made.name} skill on the selected transcripts`,
          },
        ],
      });
    }
    return json({ skill: made });
  } catch (err) {
    return fail(err);
  }
}
