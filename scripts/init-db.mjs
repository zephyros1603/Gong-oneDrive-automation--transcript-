// scripts/init-db.mjs — creates and migrates data.db exactly once, before
// anything else touches it.
//
// core/db/client.js runs its schema init (~20 CREATE TABLE IF NOT EXISTS
// statements, then an ALTER TABLE per column ever added since) as a side
// effect of being imported. On an already-migrated database that's a cheap,
// harmless no-op. On a *fresh* install it isn't: `next build`'s "Collecting
// page data" phase imports route modules across several parallel worker
// processes, each opening its own independent connection to the same
// not-yet-created data.db and racing to run the same CREATE/ALTER
// statements at once. SQLite serialises writers — on a slower machine, or
// with enough parallel workers, that queue outlasted the 5s busy_timeout and
// the build failed with SQLITE_BUSY ("database is locked"). This only ever
// showed up on a laptop that had never run the app before; a machine with
// an already-migrated data.db never hit the race, since there was nothing
// left for the competing processes to fight over.
//
// Run this once, by hand, in one process, before the parallel workers ever
// start — wired into `dev`/`build`/`serve`/`start` in package.json — and the
// schema is already fully there by the time they import it, so the race
// can't happen. A bigger busy_timeout would only ever paper over this, not
// fix it: enough concurrent workers on a slow enough disk can outlast any
// fixed timeout.
import '../core/db/client.js';

console.log('data.db ready');
