import { useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, KeyboardAvoidingView,
  Platform, ScrollView, ActivityIndicator, Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Icon } from '../src/Icon';
import { Colors } from '../src/theme';
import { api } from '../src/api';

/**
 * Change Password screen (Settings → Account → Change Password).
 *
 * Uses the existing POST /api/auth/change-password endpoint which:
 *   1) verifies the current password (trim-tolerant — strips whitespace
 *      to defeat autofill quirks),
 *   2) stores the new password as a trimmed bcrypt hash.
 *
 * UI rules:
 *   • Three fields: current / new / confirm
 *   • Each field has its own show/hide eye toggle
 *   • Submit blocked until: current is non-empty, new ≥ 6 chars, new === confirm
 *   • Success → green confirmation + auto-pop back to Settings after 1.2s
 */
export default function ChangePassword() {
  const router = useRouter();
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async () => {
    // Same trim discipline as /auth/login on the backend — strip whitespace
    // so autofill-injected spaces never silently mismatch the saved hash.
    const cur = (currentPw || '').trim();
    const next = (newPw || '').trim();
    const confirm = (confirmPw || '').trim();

    if (!cur) {
      Alert.alert('Current password required', 'Please enter your current password.');
      return;
    }
    if (next.length < 6) {
      Alert.alert('Password too short', 'New password must be at least 6 characters.');
      return;
    }
    if (next !== confirm) {
      Alert.alert("Passwords don't match", 'New password and confirmation must match.');
      return;
    }
    if (next === cur) {
      Alert.alert(
        'Choose a different password',
        'Your new password must be different from your current password.',
      );
      return;
    }

    setLoading(true);
    try {
      await api.post('/auth/change-password', {
        current_password: cur,
        new_password: next,
      });
      setDone(true);
      // Brief success state, then return to Settings.
      setTimeout(() => {
        if (router.canGoBack()) {
          router.back();
        } else {
          router.replace('/settings');
        }
      }, 1400);
    } catch (e: any) {
      const detail = e?.response?.data?.detail;
      const status = e?.response?.status;
      Alert.alert(
        status === 401 ? 'Current password is incorrect' : 'Could not change password',
        detail || 'Please double-check your current password and try again.',
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          <TouchableOpacity
            testID="cp-back"
            onPress={() => router.back()}
            style={styles.back}
            disabled={loading}
          >
            <Icon name="arrow-back" size={28} color={Colors.textPrimary} />
          </TouchableOpacity>

          <Text style={styles.title}>Change password</Text>
          <Text style={styles.subtitle}>
            Enter your current password, then choose a new one.
            New password must be at least 6 characters.
          </Text>

          {/* Current password */}
          <View style={{ marginTop: 24 }}>
            <Text style={styles.label}>Current password</Text>
            <View style={styles.pwRow}>
              <TextInput
                testID="cp-current"
                style={styles.pwInput}
                placeholder="Your current password"
                placeholderTextColor={Colors.textTertiary}
                value={currentPw}
                onChangeText={setCurrentPw}
                secureTextEntry={!showCurrent}
                autoCapitalize="none"
                autoCorrect={false}
                textContentType="password"
                autoComplete="current-password"
                importantForAutofill="yes"
                returnKeyType="next"
              />
              <TouchableOpacity
                testID="cp-current-toggle"
                style={styles.eye}
                onPress={() => setShowCurrent((v) => !v)}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                accessibilityLabel={showCurrent ? 'Hide password' : 'Show password'}
              >
                <Icon
                  name={showCurrent ? 'eye-off' : 'eye'}
                  size={22}
                  color={Colors.textSecondary}
                />
              </TouchableOpacity>
            </View>
          </View>

          {/* New password */}
          <View style={{ marginTop: 16 }}>
            <Text style={styles.label}>New password</Text>
            <View style={styles.pwRow}>
              <TextInput
                testID="cp-new"
                style={styles.pwInput}
                placeholder="At least 6 characters"
                placeholderTextColor={Colors.textTertiary}
                value={newPw}
                onChangeText={setNewPw}
                secureTextEntry={!showNew}
                autoCapitalize="none"
                autoCorrect={false}
                textContentType="newPassword"
                autoComplete="new-password"
                passwordRules="minlength: 6;"
                importantForAutofill="yes"
                returnKeyType="next"
              />
              <TouchableOpacity
                testID="cp-new-toggle"
                style={styles.eye}
                onPress={() => setShowNew((v) => !v)}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                accessibilityLabel={showNew ? 'Hide password' : 'Show password'}
              >
                <Icon
                  name={showNew ? 'eye-off' : 'eye'}
                  size={22}
                  color={Colors.textSecondary}
                />
              </TouchableOpacity>
            </View>
          </View>

          {/* Confirm new password */}
          <View style={{ marginTop: 16 }}>
            <Text style={styles.label}>Confirm new password</Text>
            <View
              style={[
                styles.pwRow,
                confirmPw.length > 0 && confirmPw !== newPw && styles.pwRowError,
              ]}
            >
              <TextInput
                testID="cp-confirm"
                style={styles.pwInput}
                placeholder="Type the new password again"
                placeholderTextColor={Colors.textTertiary}
                value={confirmPw}
                onChangeText={setConfirmPw}
                secureTextEntry={!showConfirm}
                autoCapitalize="none"
                autoCorrect={false}
                textContentType="newPassword"
                autoComplete="new-password"
                importantForAutofill="yes"
                returnKeyType="go"
                onSubmitEditing={submit}
              />
              <TouchableOpacity
                testID="cp-confirm-toggle"
                style={styles.eye}
                onPress={() => setShowConfirm((v) => !v)}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                accessibilityLabel={showConfirm ? 'Hide password' : 'Show password'}
              >
                <Icon
                  name={showConfirm ? 'eye-off' : 'eye'}
                  size={22}
                  color={Colors.textSecondary}
                />
              </TouchableOpacity>
            </View>
            {confirmPw.length > 0 && confirmPw !== newPw && (
              <Text style={styles.errText}>Passwords don't match yet.</Text>
            )}
          </View>

          {/* Submit */}
          {done ? (
            <View style={[styles.cta, styles.ctaDone]}>
              <Text style={styles.ctaText}>✅ Password changed</Text>
            </View>
          ) : (
            <TouchableOpacity
              testID="cp-submit"
              style={styles.cta}
              onPress={submit}
              disabled={loading}
              activeOpacity={0.85}
            >
              {loading ? (
                <ActivityIndicator color={Colors.surface} />
              ) : (
                <Text style={styles.ctaText}>Change password</Text>
              )}
            </TouchableOpacity>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  scroll: { padding: 24, paddingBottom: 48 },
  back: { width: 52, height: 52, justifyContent: 'center' },
  title: { fontSize: 28, fontWeight: '800', color: Colors.textPrimary, marginTop: 8 },
  subtitle: {
    fontSize: 16,
    color: Colors.textSecondary,
    marginTop: 8,
    lineHeight: 22,
  },
  label: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.textSecondary,
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  pwRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  pwRowError: { borderColor: Colors.error },
  pwInput: { flex: 1, padding: 16, fontSize: 16, color: Colors.textPrimary },
  eye: { width: 52, height: 52, alignItems: 'center', justifyContent: 'center' },
  errText: { fontSize: 13, color: Colors.error, marginTop: 6, fontWeight: '600' },
  cta: {
    marginTop: 32,
    height: 58,
    borderRadius: 16,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaDone: { backgroundColor: '#16A34A' },
  ctaText: { color: Colors.surface, fontSize: 17, fontWeight: '700' },
});
