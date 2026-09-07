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
    const dashboard = source('app/(tabs)/dashboard.tsx');
    const familyScreen = source('app/family-group.tsx');
    const apiSource = source('src/api.ts');

    expect(dashboard).toContain("router.push('/family-group')");
    expect(familyScreen).toContain('Remove from Family');
    expect(familyScreen).toContain('await removeFamilyMember(m.user_id);');
    expect(familyScreen).toContain("Alert.alert('Error'");
    expect(apiSource).toContain(
      "api.post('/family-group/remove-member', { user_id })",
    );
  });

  test('leave family is separated from member removal and requires in-app confirmation', () => {
    const familyScreen = source('app/family-group.tsx');

    expect(familyScreen).toContain('YOUR MEMBERSHIP');
    expect(familyScreen).toContain('testID="fg-membership-section"');
    expect(familyScreen).toContain('onPress={openLeaveConfirmation}');
    expect(familyScreen).toContain('visible={leaveConfirmOpen}');
    expect(familyScreen).toContain('testID="fg-leave-confirm-modal"');
    expect(familyScreen).toContain('Are you sure you want to leave this family?');
    expect(familyScreen).toContain('You will leave this family.');
    expect(familyScreen).toContain('You will become the owner of a new one-person family.');
    expect(familyScreen).toContain('Members of your current family will no longer see you.');
    expect(familyScreen).toContain('You can be invited back later.');
  });

  test('cancel cannot leave and only the destructive confirmation calls the leave API', () => {
    const familyScreen = source('app/family-group.tsx');
    const performLeaveStart = familyScreen.indexOf('const performLeave = async () =>');
    const performLeaveEnd = familyScreen.indexOf('const confirmRemove =', performLeaveStart);
    const performLeaveBody = familyScreen.slice(performLeaveStart, performLeaveEnd);

    expect(familyScreen).toContain('testID="fg-leave-cancel"');
    expect(familyScreen).toContain('onPress={() => setLeaveConfirmOpen(false)}');
    expect(familyScreen).toContain('testID="fg-leave-confirm"');
    expect(familyScreen).toContain('onPress={performLeave}');
    expect(performLeaveBody).toContain('await leaveFamilyGroup();');
    expect(familyScreen.match(/await leaveFamilyGroup\(\);/g)).toHaveLength(1);
  });
});