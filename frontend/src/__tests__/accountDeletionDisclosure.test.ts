import { readFileSync } from 'fs';
import { join } from 'path';

const source = readFileSync(join(__dirname, '../../app/(tabs)/me.tsx'), 'utf8');

describe('account deletion disclosure', () => {
  it('does not promise removal of every associated record', () => {
    expect(source).not.toContain('Permanently deletes your account and all associated data');
    expect(source).toContain('Resolved SOS history and minimal security records may be retained');
    expect(source).toContain('Resolved SOS history is retained under the 30-day policy');
  });

  it('discloses blocked delivery recovery and retained credential protection', () => {
    expect(source).toContain('Unresolved notification or email attempts can delay deletion pending review');
    expect(source).toContain('Minimal hashed security records are retained');
    expect(source).toContain('Notifications already in progress may still arrive');
  });
});
