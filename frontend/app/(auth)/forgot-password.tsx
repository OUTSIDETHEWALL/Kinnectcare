import { useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity,
  KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator, Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Icon } from '../../src/Icon';
import { Colors } from '../../src/theme';
import { api } from '../../src/api';
import { useAuth } from '../../src/AuthContext';

// Three-step forgot-password flow:
//   step 1 — enter email, request reset code
//   step 2 — enter the 6-digit code + new password
//   step 3 — auto-login + back to dashboard
//
// Backend endpoints used: POST /auth/forgot-password, POST /auth/reset-password.
export default function ForgotPassword() {
  const router = useRouter();
  const { hydrateFromToken } = useAuth() as any;
  const [step, setStep] = useState<1 | 2>(1);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  const requestCode = async () => {
    if (!email.trim()) {
      Alert.alert('Email required', 'Please enter the email you signed up with.');
      return;
    }
    setLoading(true);
    try {
      await api.post('/auth/forgot-password', { email: email.trim().toLowerCase() });
      Alert.alert(
        '📬 Check your email',
        "If an account exists for that email, we've sent a 6-digit reset code. " +
        'It expires in 15 minutes. Check your inbox (and spam folder).',
      );
      setStep(2);
    } catch (e: any) {
      Alert.alert(
        'Something went wrong',
        e?.response?.data?.detail || 'Please try again in a moment.',
      );
    } finally {
      setLoading(false);
    }
  };

  const submitReset = async () => {
    if (code.length !== 6) {
      Alert.alert('Code required', 'Please enter the 6-digit code from your email.');
      return;
    }
    if (newPassword.length < 6) {
      Alert.alert('Password too short', 'Choose a password with at least 6 characters.');
      return;
    }
    setLoading(true);
    try {
      const r = await api.post('/auth/reset-password', {
        email: email.trim().toLowerCase(),
        code: code.trim(),
        new_password: newPassword,
      });
      if (hydrateFromToken && r.data?.access_token) {
        await hydrateFromToken(r.data.access_token, r.data.user);
      }
      Alert.alert(
        '✅ Password reset',
        'Your password has been updated. Welcome back!',
        [{ text: 'OK', onPress: () => router.replace('/(tabs)/dashboard') }],
      );
    } catch (e: any) {
      Alert.alert(
        'Reset failed',
        e?.response?.data?.detail || 'Code may be invalid or expired. Please request a new code.',
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
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <TouchableOpacity onPress={() => router.back()} style={styles.back}>
            <Icon name="arrow-back" size={28} color={Colors.textPrimary} />
          </TouchableOpacity>

          <Text style={styles.title}>
            {step === 1 ? 'Reset your password' : 'Enter reset code'}
          </Text>
          <Text style={styles.subtitle}>
            {step === 1
              ? "We'll email you a 6-digit code to reset your password."
              : `We sent a code to ${email}. Enter it below and choose a new password.`}
          </Text>

          {step === 1 ? (
            <>
              <View style={{ marginTop: 24 }}>
                <Text style={styles.label}>Email</Text>
                <TextInput
                  testID="fp-email"
                  style={styles.input}
                  placeholder="you@example.com"
                  placeholderTextColor={Colors.textTertiary}
                  value={email}
                  onChangeText={setEmail}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                />
              </View>
              <TouchableOpacity
                testID="fp-request"
                style={styles.cta}
                onPress={requestCode}
                disabled={loading}
                activeOpacity={0.85}
              >
                {loading ? (
                  <ActivityIndicator color={Colors.surface} />
                ) : (
                  <Text style={styles.ctaText}>Send reset code</Text>
                )}
              </TouchableOpacity>
            </>
          ) : (
            <>
              <View style={{ marginTop: 24 }}>
                <Text style={styles.label}>6-digit code</Text>
                <TextInput
                  testID="fp-code"
                  style={[styles.input, { letterSpacing: 8, fontSize: 22, textAlign: 'center', fontWeight: '700' }]}
                  placeholder="• • • • • •"
                  placeholderTextColor={Colors.textTertiary}
                  value={code}
                  onChangeText={(v) => setCode(v.replace(/[^0-9]/g, '').slice(0, 6))}
                  keyboardType="number-pad"
                  maxLength={6}
                />
              </View>
              <View style={{ marginTop: 16 }}>
                <Text style={styles.label}>New password</Text>
                <View style={styles.passwordRow}>
                  <TextInput
                    testID="fp-new-pw"
                    style={styles.passwordInput}
                    placeholder="At least 6 characters"
                    placeholderTextColor={Colors.textTertiary}
                    value={newPassword}
                    onChangeText={setNewPassword}
                    secureTextEntry={!showPassword}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <TouchableOpacity
                    testID="fp-pw-toggle"
                    style={styles.passwordEye}
                    onPress={() => setShowPassword((v) => !v)}
                    hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                  >
                    <Icon
                      name={showPassword ? 'eye-off' : 'eye'}
                      size={22}
                      color={Colors.textSecondary}
                    />
                  </TouchableOpacity>
                </View>
              </View>
              <TouchableOpacity
                testID="fp-submit"
                style={styles.cta}
                onPress={submitReset}
                disabled={loading}
                activeOpacity={0.85}
              >
                {loading ? (
                  <ActivityIndicator color={Colors.surface} />
                ) : (
                  <Text style={styles.ctaText}>Reset password</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setStep(1)} style={{ marginTop: 16, alignItems: 'center' }}>
                <Text style={styles.link}>Resend code or change email</Text>
              </TouchableOpacity>
            </>
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
  subtitle: { fontSize: 16, color: Colors.textSecondary, marginTop: 8, lineHeight: 22 },
  label: { fontSize: 13, fontWeight: '700', color: Colors.textSecondary, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  input: {
    backgroundColor: Colors.surface, borderRadius: 14, padding: 16, fontSize: 16,
    color: Colors.textPrimary, borderWidth: 1, borderColor: Colors.border,
  },
  passwordRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  passwordInput: { flex: 1, padding: 16, fontSize: 16, color: Colors.textPrimary },
  passwordEye: { width: 52, height: 52, alignItems: 'center', justifyContent: 'center' },
  cta: {
    marginTop: 28, height: 58, borderRadius: 16, backgroundColor: Colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  ctaText: { color: Colors.surface, fontSize: 17, fontWeight: '700' },
  link: { color: Colors.primary, fontSize: 15, fontWeight: '600' },
});
