export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { json, fail, readBody } from '@/core/http.js';
import { getConnector } from '@/core/connectors/registry.js';
import { envDefaults, saveEnv } from '@/core/env.js';
import { readSettings, writeSettings } from '@/settings.js';
import { loadConfig } from '@/gong.js';
import { readAutomation, writeAutomation } from '@/automation.js';
import * as library from '@/library.js';

/**
 * Where each application's values actually live.
 *
 * Deliberately not one store: a Gong host belongs in gong.env because the CLI
 * reads it with no server running, while a turn cap is UI state. The form does
 * not need to know the difference.
 */
function readValues(id) {
  const cfg = loadConfig();
  const s = readSettings();

  if (id === 'gong') return envDefaults();
  if (id === 'claude') {
    return { model: s.model || '', maxTurns: String(s.maxTurns ?? 40), outputDir: s.outputDir };
  }
  if (id === 'projects') {
    return { sortedDir: cfg.sortedDir, autoSync: s.autoSyncProjects === false ? 'off' : 'on' };
  }
  if (id === 'library') {
    return {
      GONG_OUT_DIR: cfg.outDir,
      GONG_SORTED_DIR: cfg.sortedDir,
      outputDir: s.outputDir,
      GONG_PREVIEW_DIRS: cfg.previewDirs || '',
    };
  }
  if (id === 'automation') {
    const a = readAutomation();
    return {
      defaultTime: a.time || '09:00',
      defaultGrace: String(a.graceMinutes ?? 20),
      maxTurns: String(s.maxTurns ?? 40),
    };
  }
  return {};
}

export async function GET(req, { params }) {
  const { id } = await params;
  const c = getConnector(id);
  if (!c) return json({ error: 'no such application' }, 404);

  let status = { configured: false, connected: false, detail: 'Not available yet' };
  if (!c.planned && c.status) {
    try { status = await c.status(); } catch (err) { status = { configured: false, connected: false, detail: err.message }; }
  }

  return json({
    connector: {
      id: c.id, name: c.name, vendor: c.vendor, kind: c.kind, auth: c.auth,
      capabilities: c.capabilities, planned: Boolean(c.planned),
      tabs: c.tabs || ['Configuration'],
      configSchema: c.configSchema || [], credentialSchema: c.credentialSchema || [],
      dataTab: c.dataTab || null,
    },
    values: readValues(id),
    status,
  });
}

export async function POST(req, { params }) {
  const { id } = await params;
  const c = getConnector(id);
  if (!c) return json({ error: 'no such application' }, 404);

  const body = await readBody(req);
  try {
    // A test is a dry run — it must never write. That is the whole reason the
    // cookie intake verifies before it saves.
    if (body.action === 'test') return json(await c.test(body.values || {}));

    if (body.action === 'save') {
      const v = body.values || {};
      if (id === 'gong') return json({ saved: saveEnv(v) });
      if (id === 'claude') {
        return json({ saved: writeSettings({
          model: v.model ?? '',
          maxTurns: Number(v.maxTurns) || 40,
          outputDir: v.outputDir,
        }) });
      }
      if (id === 'projects') {
        if (v.sortedDir) saveEnv({ GONG_SORTED_DIR: v.sortedDir });
        writeSettings({ autoSyncProjects: v.autoSync !== 'off' });
        library.refresh();
        return json({ saved: true });
      }
      if (id === 'library') {
        saveEnv({
          GONG_OUT_DIR: v.GONG_OUT_DIR,
          GONG_SORTED_DIR: v.GONG_SORTED_DIR,
          GONG_PREVIEW_DIRS: v.GONG_PREVIEW_DIRS || '',
        });
        writeSettings({ outputDir: v.outputDir });
        library.refresh();   // paths changed; the cached tree is now wrong
        return json({ saved: true });
      }
      if (id === 'automation') {
        writeAutomation({
          time: v.defaultTime || '09:00',
          graceMinutes: Number(v.defaultGrace) || 20,
        });
        writeSettings({ maxTurns: Number(v.maxTurns) || 40 });
        return json({ saved: true });
      }
      if (id === 'graph') return json({ saved: true });   // policy lives on the Graph page
      return json({ error: 'this application cannot be configured yet' }, 400);
    }
    return json({ error: 'unknown action' }, 400);
  } catch (err) {
    return fail(err);
  }
}
