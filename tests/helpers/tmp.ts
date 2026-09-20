import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

const made: string[] = [];

/**
 * A throwaway directory, resolved through symlinks.
 *
 * The resolution is not a detail. On macOS `os.tmpdir()` answers `/var/folders/…`, a
 * symlink to `/private/var/folders/…`, and the boundary check under test resolves the
 * paths it is given. A test that compared against the unresolved form would fail for
 * exactly the reason the production code goes out of its way to handle.
 */
export const tempDir = (label = 'ambassy'): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `${label}-`)));
  made.push(dir);
  return dir;
};

afterEach(() => {
  let dir = made.pop();
  while (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = made.pop();
  }
});
