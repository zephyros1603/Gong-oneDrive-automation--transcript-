/**
 * core/paths.js — where things are on disk, resolved once.
 *
 * Modules under core/ are one directory deeper than the code they came from,
 * so anything that used to say `dirname(fileURLToPath(import.meta.url))` and
 * mean "the project" has to say it here instead. Resolving it in one place
 * stops that arithmetic being repeated (and eventually got wrong) per module.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The project root — the directory holding gong.env, one level above core/. */
export const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Config and credentials. Written mode 0600; never moves into a database. */
export const ENV_PATH = join(PROJECT_ROOT, 'gong.env');
