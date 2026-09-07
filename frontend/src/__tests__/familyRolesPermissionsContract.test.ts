import fs from 'fs';
import path from 'path';

const projectRoot = path.resolve(__dirname, '../..');

function source(relativePath: string): string {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

describe('family role UI permissions', () => {
  test('family-group administration is rendered only for owners', () => {
    const screen = source('app/family-group.tsx');

    expect(screen).toContain("const isOwner = myRole === 'owner';");
    expect(screen).toContain('{isOwner ? (');
    expect(screen).toContain('testID="fg-invite-code-section"');
    expect(screen).toContain('testID="fg-copy-code"');
    expect(screen).toContain('testID="fg-share-code"');
    expect(screen).toContain('testID="fg-regen-code"');
    expect(screen).toContain('testID="fg-email-invites"');
    expect(screen).toContain('{isOwner ? <View style={styles.card} testID="fg-email-invites">');
    expect(screen).toContain('visible={isOwner && renameOpen}');
    expect(screen).toContain('visible={isOwner && inviteOpen}');
    expect(screen).toContain('if (!isOwner) return;');
  });

  test('members retain their own membership controls without family administration', () => {
    const screen = source('app/family-group.tsx');

    expect(screen).toContain('testID="fg-membership-section"');
    expect(screen).toContain('testID="fg-leave"');
    expect(screen).toContain('testID="fg-open-join"');
    expect(screen).toContain('if (r.my_role === \'owner\')');
    expect(screen).toContain('setInvites([]);');
  });

  test('member detail separates owner administration from self-only completion', () => {
    const screen = source('app/member/[id].tsx');

    expect(screen).toContain("import { useFamilyGroupRole } from '../../src/useFamilyGroupRole';");
    expect(screen).toContain('const familyRole = useFamilyGroupRole();');
    expect(screen).toContain('const isOwnMemberRecord = member.user_id === user?.id;');
    expect(screen).toContain('const canManageReminders = isOwner;');
    expect(screen).toContain('const canManageCheckin = familyRole.isResolved && (isOwner || isOwnMemberRecord);');
    expect(screen).toContain('canMark={isOwnMemberRecord}');
    expect(screen).toContain('canManage={canManageReminders}');
    expect(screen).toContain('{canMark ? <TouchableOpacity');
    expect(screen).toContain('{canManage ? <TouchableOpacity');
    expect(screen).toContain("if (!familyRole.isResolved || member?.user_id !== user?.id) return;");
    expect(screen).toContain('if (!familyRole.isOwner) return;');
  });

  test('direct reminder administration routes hide submission for non-owners', () => {
    const addMedication = source('app/add-medication/[memberId].tsx');
    const addRoutine = source('app/add-routine/[memberId].tsx');
    const editMedication = source('app/edit-medication/[reminderId].tsx');

    for (const route of [addMedication, addRoutine, editMedication]) {
      expect(route).toContain('useFamilyGroupRole');
      expect(route).toContain('const familyRole = useFamilyGroupRole();');
      expect(route).toContain('if (!familyRole.isOwner) return;');
    }
    expect(addMedication).toContain('testID="add-med-access-denied"');
    expect(addRoutine).toContain('testID="add-routine-access-denied"');
    expect(editMedication).toContain('testID="edit-med-access-denied"');
    expect(addMedication).toContain('testID="add-med-role-loading"');
    expect(addRoutine).toContain('testID="add-routine-role-loading"');
    expect(editMedication).toContain('testID="edit-med-role-loading"');
  });
});