// scripts/create-projects.js — the creation run, as an Engine script.
//
// Paste this into a new script on the Engine page (/engine), save it, and
// either "Run" it by hand or schedule it (the Schedule button appears once
// it's saved). Cheap to run often: it's read-only against CX Portal
// (list_projects, GET) and only ever creates a stub context.md for a CX
// Portal project it hasn't seen before — no Claude call, no write to CX
// Portal, nothing posted anywhere. Safe to run daily.
//
// What it does:
//   1. Fetches every CX Portal project assigned to you (myProjectsOnly, with
//      the IC/secondary-IC fallback if the server ignores that flag).
//   2. For each one not already linked to a Warp project (by cxpProjectId,
//      not by name), creates a Warp project + a cheap stub context.md.
//   3. Leaves everything else untouched — a project already linked is
//      reported, never duplicated.
//
// This only creates projects. Run scripts/update-context.js afterwards (or
// on its own schedule) to actually fill in a new project's context.md with
// real Gong + CX Portal material.

const result = await warp.projects.syncFromCxp();

console.log(`${result.fetched} CX Portal project(s) assigned to you`);
console.log(`${result.created.length} new project(s) created`);
console.log(`${result.existing.length} already linked`);

for (const p of result.created) {
  console.log(`  + ${p.name}  (${p.cxpProjectId})`);
}

return {
  fetched: result.fetched,
  created: result.created.length,
  createdNames: result.created.map((p) => p.name),
  existing: result.existing.length,
};
