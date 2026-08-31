import { execFileSync } from 'node:child_process';
import path from 'node:path';

const repositoryRoot = path.resolve(__dirname, '../../..');
const prohibitedLegacyIdentifier = ['joy', 'ce'].join('');

describe('legacy beta artifact repository boundary', () => {
  it('keeps the legacy identifier out of tracked files except quarantined migration exports', () => {
    let matches = '';
    try {
      matches = execFileSync(
        'git',
        [
          'grep',
          '-n',
          '-i',
          prohibitedLegacyIdentifier,
          '--',
          ':!kinnship-migration/**',
        ],
        { cwd: repositoryRoot, encoding: 'utf8' },
      );
    } catch (error: any) {
      if (error?.status === 1) return;
      throw error;
    }

    expect(matches).toBe('');
  });
});