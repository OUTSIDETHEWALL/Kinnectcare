import { execFileSync } from 'node:child_process';
import path from 'node:path';

it('reproduces the legacy context exception and verifies the production hook with real installed contexts', () => {
  // A separate Node process deliberately avoids all Jest navigation mocks.
  expect(() => execFileSync(process.execPath, [
    path.resolve(__dirname, '../../scripts/verify-sos-router-context.mjs'),
  ], { encoding: 'utf8', timeout: 20_000, stdio: 'pipe' })).not.toThrow();
});
