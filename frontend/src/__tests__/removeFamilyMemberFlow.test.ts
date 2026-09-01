import fs from 'fs';
import path from 'path';

const projectRoot = path.resolve(__dirname, '../..');

function source(relativePath: string): string {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

describe('family account removal flow', () => {
  test('the member detail screen cannot masquerade profile deletion as family removal', () => {
    const memberDetail = source('app/member/[id].tsx');

    expect(memberDetail).not.toContain('Remove member');
    expect(memberDetail).not.toContain('api.delete(`/members/${id}`)');
    expect(memberDetail).not.toContain('testID="member-delete"');
  });

  test('the family management screen uses the account membership endpoint', () => {
    const familyScreen = source('app/family-group.tsx');
    const apiSource = source('src/api.ts');

    expect(familyScreen).toContain('await removeFamilyMember(m.user_id);');
    expect(familyScreen).toContain("Alert.alert('Error'");
    expect(apiSource).toContain(
      "api.post('/family-group/remove-member', { user_id })",
    );
  });
});