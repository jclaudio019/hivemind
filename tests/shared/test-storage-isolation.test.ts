import { expect, it } from 'vitest';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { isLocalMode } from '../../src/storage/local-mode.js';

it('isolates the default backend and storage from the developer home', () => {
  const home = homedir();
  const underTemp = relative(tmpdir(), home);
  expect(underTemp.startsWith('..')).toBe(false);
  expect(home).not.toBe(tmpdir());
  expect(process.env.HIVEMIND_LOCAL_ROOT).toBe(join(home, '.local-hivemind'));
  expect(isLocalMode()).toBe(false);
});
