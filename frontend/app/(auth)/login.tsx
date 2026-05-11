import { useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, KeyboardAvoidingView,
  Platform, ScrollView, ActivityIndicator, Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors } from '../../src/theme';
import { useAuth } from '../../src/AuthContext';

export default function Login() {
  const router = useRouter();
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const onSubmit = async () => {
    if (!email.trim() || !password) {
      Alert.alert('Missing info', 'Please enter your email and password.');
      return;
    }
    setLoading(true);
    try {
      await login(email.trim(), password);
      router.replace('/(tabs)/dashboard');
    } catch (e: any) {
      Alert.alert('Sign in failed', e?.response?.data?.detail || 'Please check your credentials.');
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
          <TouchableOpacity testID="login-back" onPress={() => router.back()} style={styles.back}>
            <Ionicons name="arrow-back" size={24} color={Colors.textPrimary} />
          </TouchableOpacity>

          <View style={styles.logoWrap}>
            <View style={styles.logoCircle}>
              <Ionicons name="shield-checkmark" size={36} color={Colors.surface} />
            </View>
          </View>
          <Text style={styles.title}>Welcome back</Text>
          <Text style={styles.subtitle}>Sign in to keep your family safe.</Text>

          <View style={{ marginTop: 16 }}>
            <Text style={styles.label}>Email</Text>
            <TextInput
              testID="login-email"
              style={styles.input}
              placeholder="you@example.com"
              placeholderTextColor={Colors.textTertiary}
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
            />
          </View>

          <View style={{ marginTop: 16 }}>
            <Text style={styles.label}>Password</Text>
            <TextInput
              testID="login-password"
              style={styles.input}
              placeholder="••••••••"
              placeholderTextColor={Colors.textTertiary}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
            />
          </View>

          <TouchableOpacity testID="login-submit" style={styles.cta} onPress={onSubmit} disabled={loading} activeOpacity={0.85}>
            {loading ? <ActivityIndicator color={Colors.surface} /> : <Text style={styles.ctaText}>Sign in</Text>}
          </TouchableOpacity>

          <TouchableOpacity testID="login-to-signup" onPress={() => router.replace('/(auth)/signup')} style={{ marginTop: 18, alignItems: 'center' }}>
            <Text style={styles.link}>New here? <Text style={{ fontWeight: '700', color: Colors.primary }}>Create an account</Text></Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  scroll: { padding: 24, paddingBottom: 48 },
  back: { width: 44, height: 44, justifyContent: 'center' },
  logoWrap: { alignItems: 'center', marginTop: 16, marginBottom: 8 },
  logoCircle: {
    width: 76, height: 76, borderRadius: 38, backgroundColor: Colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  title: { fontSize: 28, fontWeight: '800', color: Colors.textPrimary, marginTop: 16, textAlign: 'center' },
  subtitle: { fontSize: 16, color: Colors.textSecondary, textAlign: 'center', marginTop: 6 },
  label: { fontSize: 13, fontWeight: '700', color: Colors.textSecondary, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  input: {
    backgroundColor: Colors.surface, borderRadius: 14, padding: 16, fontSize: 16,
    color: Colors.textPrimary, borderWidth: 1, borderColor: Colors.border,
  },
  cta: {
    marginTop: 28, height: 58, borderRadius: 16, backgroundColor: Colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  ctaText: { color: Colors.surface, fontSize: 17, fontWeight: '700' },
  link: { color: Colors.textSecondary, fontSize: 15 },
});
