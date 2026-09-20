export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json, fail } from '@/core/http.js';
import { loadConfig } from '@/gong.js';
import { ACTIONS, shapeOf } from '@/core/connectors/cxportal.js';
import { cxClient } from '@/core/connectors/cx-client.js';

/**
 * Read from the CX Portal, and report the shape of what came back.
 *
 * Response schemas were never captured, so this endpoint is deliberately a
 * probe as well as a reader: `?shape=1` returns the structure rather than the
 * data, which is how the field mapping gets filled in without pasting customer
 * records into a document.
 */
export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const cfg = loadConfig();
  const client = cxClient();

  const action = searchParams.get('action') || 'list_projects';
  if (!ACTIONS.includes(action)) {
    return json({ error: `unknown action: ${action}`, known: ACTIONS }, 400);
  }

  try {
    let data;
    if (action === 'list_projects') {
      const mine = searchParams.get('mine') === '1' && cfg.cxConsultant;
      data = mine
        ? await client.projectsForConsultant(cfg.cxConsultant, {
            size: Number(searchParams.get('size')) || 50,
          })
        : await client.listProjects({
            size: Number(searchParams.get('size')) || 50,
            hideClosed: cfg.cxHideClosed,
          });
    } else {
      data = await client.action(action);
    }

    if (searchParams.get('shape')) {
      return json({ action, shape: shapeOf(data), tokenInfo: client.tokenInfo() });
    }
    return json({ action, data, tokenInfo: client.tokenInfo() });
  } catch (err) {
    return fail(err);
  }
}
