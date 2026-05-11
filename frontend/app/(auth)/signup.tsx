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

export default function Signup() {
  const router = useRouter();
  const { signup } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const onSubmit = async () => {
    if (!name.trim() || !email.trim() || password.length < 6) {
      Alert.alert('Missing info', 'Please enter your name, a valid email, and a password (min 6 chars).');
      return;
    }
    setLoading(true);
    try {
      await signup(email.trim(), password, name.trim());
      router.replace('/(tabs)/dashboard');
    } catch (e: any) {
      Alert.alert('Sign up failed', e?.response?.data?.detail || 'Please try again.');
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
          <TouchableOpacity testID="signup-back" onPress={() => router.back()} style={styles.back}>
            <Ionicons name="arrow-back" size={24} color={Colors.textPrimary} />
          </TouchableOpacity>
          <Text style={styles.title}>Create your account</Text>
          <Text style={styles.subtitle}>Start protecting your loved ones in minutes.</Text>

          <Field label="Full name" value={name} onChangeText={setName} placeholder="Jane Smith" testID="signup-name" />
          <Field label="Email" value={email} onChangeText={setEmail} placeholder="you@example.com" keyboardType="email-address" autoCapitalize="none" testID="signup-email" />
          <Field label="Password" value={password} onChangeText={setPassword} placeholder="••••••••" secureTextEntry testID="signup-password" />

          <TouchableOpacity testID="signup-submit" style={styles.cta} onPress={onSubmit} disabled={loading} activeOpacity={0.85}>
            {loading ? <ActivityIndicator color={Colors.surface} /> : <Text style={styles.ctaText}>Create Account</Text>}
          </TouchableOpacity>

          <TouchableOpacity testID="signup-to-login" onPress={() => router.replace('/(auth)/login')} style={{ marginTop: 18, alignItems: 'center' }}>
            <Text style={styles.link}>Already have an account? <Text style={{ fontWeight: '700', color: Colors.primary }}>Sign in</Text></Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Field(props: any) {
  return (
    <View style={{ marginTop: 16 }}>
      <Text style={styles.label}>{props.label}</Text>
      <TextInput
        {...props}
        style={styles.input}
        placeholderTextColor={Colors.textTertiary}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  scroll: { padding: 24, paddingBottom: 48 },
  back: { width: 44, height: 44, justifyContent: 'center' },
  title: { fontSize: 28, fontWeight: '800', color: Colors.textPrimary, marginTop: 8 },
  subtitle: { fontSize: 16, color: Colors.textSecondary, marginTop: 6, marginBottom: 8 },
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
