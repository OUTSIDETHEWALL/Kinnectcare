import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  Modal,
  TextInput,
  ActivityIndicator,
  Share,
  Platform,
} from 'react-native';
import { useEffect, useState, useCallback } from 'react';
import { useRouter, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import { Icon } from '../src/Icon';
import { Colors } from '../src/theme';
import {
  getFamilyGroup,
  renameFamilyGroup,
  regenerateInviteCode,
  joinFamilyGroup,
  leaveFamilyGroup,
  removeFamilyMember,
  FamilyGroupResponse,
} from '../src/api';
import { useAuth } from '../src/AuthContext';
import { APP_NAME } from '../src/legal';

export default function FamilyGroupScreen() {
  const router = useRouter();
  const { user, refreshUser } = useAuth();
  const [data, setData] = useState<FamilyGroupResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Modals
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [joinOpen, setJoinOpen] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [joinError, setJoinError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const r = await getFamilyGroup();
      setData(r);
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || 'Failed to load family');
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const myRole = data?.my_role;
  const isOwner = myRole === 'owner';

  const onCopyCode = async () => {
    if (!data?.group?.invite_code) return;
    try {
      await Clipboard.setStringAsync(data.group.invite_code);
      Alert.alert('Copied!', 'Invite code copied to clipboard.');
    } catch {
      Alert.alert('Code', data.group.invite_code);
    }
  };

  const onShareCode = async () => {
    if (!data?.group?.invite_code) return;
    const msg = `Join my family on ${APP_NAME}! Use invite code: ${data.group.invite_code}`;
    try {
      await Share.share({ message: msg });
    } catch {
      onCopyCode();
    }
  };

  const onRegenerate = async () => {
    if (!isOwner) return;
    Alert.alert(
      'Regenerate invite code?',
      'The old code will stop working. Anyone you already shared it with will need the new code to join.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Regenerate',
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            try {
              await regenerateInviteCode();
              await load();
            } catch (e: any) {
              Alert.alert('Error', e?.response?.data?.detail || 'Failed to regenerate code');
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  };

  const openRename = () => {
    setRenameValue(data?.group?.name || '');
    setRenameOpen(true);
  };

  const submitRename = async () => {
    const v = renameValue.trim();
    if (!v) {
      Alert.alert('Name required', 'Please enter a name.');
      return;
    }
    setBusy(true);
    try {
      await renameFamilyGroup(v);
      setRenameOpen(false);
      await load();
    } catch (e: any) {
      Alert.alert('Error', e?.response?.data?.detail || 'Failed to rename');
    } finally {
      setBusy(false);
    }
  };

  const submitJoin = async () => {
    const code = joinCode.trim().toUpperCase();
    if (!code) {
      setJoinError('Please enter an invite code.');
      return;
    }
    setBusy(true);
    setJoinError(null);
    try {
      await joinFamilyGroup(code);
      setJoinOpen(false);
      setJoinCode('');
      await refreshUser?.();
      await load();
      Alert.alert('Joined!', 'You are now part of this family.');
    } catch (e: any) {
      setJoinError(e?.response?.data?.detail || e?.message || 'Failed to join');
    } finally {
      setBusy(false);
    }
  };

  const confirmLeave = () => {
    if (isOwner && (data?.member_count || 0) > 1) {
      Alert.alert(
        'You\'re the owner',
        'Transfer ownership or remove other members first before leaving.',
      );
      return;
    }
    Alert.alert(
      'Leave family?',
      'You will be moved to a brand-new family group with your own data. You can be invited back any time.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Leave',
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            try {
              await leaveFamilyGroup();
              await refreshUser?.();
              await load();
            } catch (e: any) {
              Alert.alert('Error', e?.response?.data?.detail || 'Failed to leave');
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  };

  const confirmRemove = (m: { user_id: string; full_name: string }) => {
    Alert.alert(
      `Remove ${m.full_name}?`,
      'They will be moved to a new family group of their own. Their access to this family ends immediately.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            try {
              await removeFamilyMember(m.user_id);
              await load();
            } catch (e: any) {
              Alert.alert('Error', e?.response?.data?.detail || 'Failed to remove');
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity
          testID="family-group-back"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/dashboard'))}
          style={styles.backBtn}
        >
          <Icon name="arrow-back" size={22} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Family Group</Text>
        <View style={{ width: 44 }} />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.errorTxt}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={load}>
            <Text style={styles.retryTxt}>Try again</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.scroll}>
          {/* Group header card */}
          <View style={styles.card}>
            <View style={styles.cardTopRow}>
              <Text style={styles.cardEyebrow}>FAMILY</Text>
              {isOwner ? (
                <TouchableOpacity testID="fg-rename" onPress={openRename} hitSlop={10}>
                  <Text style={styles.editLink}>Edit ✏️</Text>
                </TouchableOpacity>
              ) : null}
            </View>
            <Text style={styles.groupName} testID="fg-name">
              {data?.group?.name || 'Family'}
            </Text>
            <Text style={styles.memberCount}>
              👥 {data?.member_count || 0} {data?.member_count === 1 ? 'member' : 'members'} in this family
            </Text>
          </View>

          {/* Invite code card */}
          <View style={styles.card}>
            <Text style={styles.sectionLabel}>INVITE CODE</Text>
            <Text style={styles.sectionHelp}>
              Share this code with family. Anyone who signs up with it will join this family and see the
              same dashboard, alerts, and SOS notifications.
            </Text>
            <View style={styles.codeBox} testID="fg-code-box">
              <Text style={styles.codeText} testID="fg-invite-code" selectable>
                {data?.group?.invite_code || '—'}
              </Text>
            </View>
            <View style={styles.codeBtnRow}>
              <TouchableOpacity style={styles.codeBtn} onPress={onCopyCode} testID="fg-copy-code">
                <Text style={styles.codeBtnTxt}>📋 Copy</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.codeBtn} onPress={onShareCode} testID="fg-share-code">
                <Text style={styles.codeBtnTxt}>↗ Share</Text>
              </TouchableOpacity>
              {isOwner ? (
                <TouchableOpacity
                  style={[styles.codeBtn, styles.codeBtnRegen]}
                  onPress={onRegenerate}
                  testID="fg-regen-code"
                  disabled={busy}
                >
                  <Text style={[styles.codeBtnTxt, { color: Colors.error }]}>↻ Regenerate</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          </View>

          {/* Members list */}
          <View style={styles.card}>
            <Text style={styles.sectionLabel}>MEMBERS</Text>
            {(data?.members || []).map((m, i) => {
              const isMe = m.user_id === user?.id;
              return (
                <View key={m.user_id}>
                  {i > 0 ? <View style={styles.divider} /> : null}
                  <View style={styles.memberRow} testID={`fg-member-${m.user_id}`}>
                    <View style={styles.avatar}>
                      <Text style={styles.avatarTxt}>
                        {(m.full_name || '?').trim().charAt(0).toUpperCase()}
                      </Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.memberName}>
                        {m.full_name} {isMe ? <Text style={styles.youTag}>· You</Text> : null}
                      </Text>
                      <Text style={styles.memberEmail} numberOfLines={1}>{m.email}</Text>
                    </View>
                    {m.role === 'owner' ? (
                      <View style={styles.ownerPill}>
                        <Text style={styles.ownerPillTxt}>⭐ Owner</Text>
                      </View>
                    ) : isOwner ? (
                      <TouchableOpacity
                        onPress={() => confirmRemove(m)}
                        testID={`fg-remove-${m.user_id}`}
                        hitSlop={10}
                      >
                        <Text style={styles.removeTxt}>Remove</Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                </View>
              );
            })}
          </View>

          {/* Actions */}
          <View style={styles.card}>
            <TouchableOpacity
              style={styles.actionPrimary}
              onPress={() => {
                setJoinError(null);
                setJoinCode('');
                setJoinOpen(true);
              }}
              testID="fg-open-join"
            >
              <Text style={styles.actionPrimaryTxt}>🤝 Join a different family</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.actionSecondary}
              onPress={confirmLeave}
              testID="fg-leave"
            >
              <Text style={styles.actionSecondaryTxt}>↩ Leave this family</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.footnote}>
            When ANY family member triggers SOS or fall detection, all linked accounts in this family
            receive an instant push notification with the person's name, GPS coordinates, and
            timestamp — so you can respond together.
          </Text>
        </ScrollView>
      )}

      {/* Rename modal */}
      <Modal
        visible={renameOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setRenameOpen(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Rename Family</Text>
            <TextInput
              testID="fg-rename-input"
              style={styles.input}
              value={renameValue}
              onChangeText={setRenameValue}
              placeholder="The Smith Family"
              maxLength={80}
              autoFocus
            />
            <View style={styles.modalBtnRow}>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnCancel]}
                onPress={() => setRenameOpen(false)}
                disabled={busy}
              >
                <Text style={styles.modalBtnCancelTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnPrimary]}
                onPress={submitRename}
                disabled={busy}
                testID="fg-rename-submit"
              >
                <Text style={styles.modalBtnPrimaryTxt}>{busy ? 'Saving…' : 'Save'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Join modal */}
      <Modal
        visible={joinOpen}
        transparent
        animationType="fade"
        onRequestClose={() => !busy && setJoinOpen(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Join a Family</Text>
            <Text style={styles.modalBody}>
              Enter the invite code shared with you. Your current family data will move with you to
              the new family.
            </Text>
            <TextInput
              testID="fg-join-input"
              style={styles.input}
              value={joinCode}
              onChangeText={(v) => setJoinCode(v.toUpperCase())}
              placeholder="KINN-XXXXXX"
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={20}
              autoFocus
            />
            {joinError ? <Text style={styles.errorTxt}>{joinError}</Text> : null}
            <View style={styles.modalBtnRow}>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnCancel]}
                onPress={() => setJoinOpen(false)}
                disabled={busy}
              >
                <Text style={styles.modalBtnCancelTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnPrimary]}
                onPress={submitJoin}
                disabled={busy}
                testID="fg-join-submit"
              >
                <Text style={styles.modalBtnPrimaryTxt}>{busy ? 'Joining…' : 'Join'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: Colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  backBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '700', color: Colors.textPrimary },
  scroll: { padding: 16, paddingBottom: 48 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  errorTxt: { color: Colors.error, fontSize: 14, marginTop: 8 },
  retryBtn: { marginTop: 12, paddingHorizontal: 20, paddingVertical: 10, backgroundColor: Colors.primary, borderRadius: 8 },
  retryTxt: { color: Colors.surface, fontWeight: '600' },

  card: {
    backgroundColor: Colors.surface,
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  cardTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  cardEyebrow: { fontSize: 11, color: Colors.textTertiary, letterSpacing: 1.5, fontWeight: '700' },
  editLink: { fontSize: 13, color: Colors.primary, fontWeight: '600' },
  groupName: { fontSize: 22, fontWeight: '800', color: Colors.textPrimary, marginTop: 4 },
  memberCount: { fontSize: 13, color: Colors.textSecondary, marginTop: 4 },

  sectionLabel: { fontSize: 11, color: Colors.textTertiary, letterSpacing: 1.5, fontWeight: '700', marginBottom: 8 },
  sectionHelp: { fontSize: 13, color: Colors.textSecondary, lineHeight: 19, marginBottom: 12 },

  codeBox: {
    backgroundColor: Colors.tertiary,
    borderRadius: 12,
    paddingVertical: 18,
    paddingHorizontal: 16,
    alignItems: 'center',
    marginBottom: 12,
    borderWidth: 2,
    borderColor: Colors.primary,
    borderStyle: 'dashed',
  },
  codeText: {
    fontSize: 26,
    fontWeight: '800',
    color: Colors.primary,
    letterSpacing: 3,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
  codeBtnRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  codeBtn: {
    flex: 1,
    minWidth: 90,
    backgroundColor: Colors.tertiary,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  codeBtnRegen: { backgroundColor: Colors.errorBg },
  codeBtnTxt: { fontSize: 13, fontWeight: '600', color: Colors.primary },

  divider: { height: 1, backgroundColor: Colors.border, marginVertical: 8 },
  memberRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.tertiary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  avatarTxt: { fontSize: 16, fontWeight: '700', color: Colors.primary },
  memberName: { fontSize: 15, fontWeight: '600', color: Colors.textPrimary },
  youTag: { fontSize: 12, color: Colors.textTertiary, fontWeight: '500' },
  memberEmail: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  ownerPill: {
    backgroundColor: Colors.successBg,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  ownerPillTxt: { fontSize: 11, fontWeight: '700', color: Colors.success },
  removeTxt: { fontSize: 13, color: Colors.error, fontWeight: '600' },

  actionPrimary: {
    backgroundColor: Colors.primary,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 8,
  },
  actionPrimaryTxt: { color: Colors.surface, fontSize: 15, fontWeight: '700' },
  actionSecondary: {
    backgroundColor: Colors.errorBg,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  actionSecondaryTxt: { color: Colors.error, fontSize: 15, fontWeight: '600' },

  footnote: { fontSize: 12, color: Colors.textTertiary, lineHeight: 18, textAlign: 'center', paddingHorizontal: 12, marginTop: 4 },

  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  modalCard: { backgroundColor: Colors.surface, borderRadius: 16, padding: 20, width: '100%', maxWidth: 360 },
  modalTitle: { fontSize: 18, fontWeight: '700', color: Colors.textPrimary, marginBottom: 8 },
  modalBody: { fontSize: 13, color: Colors.textSecondary, marginBottom: 12, lineHeight: 19 },
  input: {
    backgroundColor: Colors.background,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: 8,
    color: Colors.textPrimary,
  },
  modalBtnRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 8 },
  modalBtn: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 8, minWidth: 80, alignItems: 'center' },
  modalBtnCancel: { backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border },
  modalBtnCancelTxt: { color: Colors.textPrimary, fontWeight: '600' },
  modalBtnPrimary: { backgroundColor: Colors.primary },
  modalBtnPrimaryTxt: { color: Colors.surface, fontWeight: '700' },
});
