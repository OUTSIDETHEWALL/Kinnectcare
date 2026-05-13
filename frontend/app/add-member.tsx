import { useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, ScrollView,
  KeyboardAvoidingView, Platform, Alert, ActivityIndicator, Modal,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Icon } from '../src/Icon';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors } from '../src/theme';
import { api, isPaywall } from '../src/api';

const GENDERS = ['Male', 'Female', 'Other'];

export default function AddMember() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [age, setAge] = useState('');
  const [phone, setPhone] = useState('');
  const [gender, setGender] = useState('Male');
  const [loading, setLoading] = useState(false);
  const [paywallMsg, setPaywallMsg] = useState<string | null>(null);

  const onSubmit = async () => {
    const n = parseInt(age, 10);
    if (!name.trim() || !age || isNaN(n) || n < 1 || n > 120 || !phone.trim()) {
      Alert.alert('Missing info', 'Please fill in all fields with valid values.');
      return;
    }
    setLoading(true);
    try {
      const role = n >= 60 ? 'senior' : 'family';
      await api.post('/members', { name: name.trim(), age: n, phone: phone.trim(), gender, role });
      router.back();
    } catch (e: any) {
      const pw = isPaywall(e);
      if (pw) {
        setPaywallMsg(pw.message);
      } else {
        Alert.alert('Failed to add', e?.response?.data?.detail || 'Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <View style={styles.header}>
          <TouchableOpacity testID="add-member-back" onPress={() => router.back()} style={styles.iconBtn}>
            <Icon name="close" size={22} color={Colors.textPrimary} />
          </TouchableOpacity>
          <Text style={styles.title}>Add Family Member</Text>
          <View style={{ width: 44 }} />
        </View>

        <ScrollView contentContainerStyle={{ padding: 24 }} keyboardShouldPersistTaps="handled">
          <Text style={styles.subtitle}>Help us keep them safe with personalized care reminders and alerts.</Text>

          <Field label="Full name" testID="member-name">
            <TextInput
              testID="member-name-input"
              value={name}
              onChangeText={setName}
              placeholder="James Smith"
              placeholderTextColor={Colors.textTertiary}
              style={styles.input}
            />
          </Field>

          <Field label="Age" testID="member-age">
            <TextInput
              testID="member-age-input"
              value={age}
              onChangeText={setAge}
              placeholder="78"
              keyboardType="number-pad"
              placeholderTextColor={Colors.textTertiary}
              style={styles.input}
            />
          </Field>

          <Field label="Phone number" testID="member-phone">
            <TextInput
              testID="member-phone-input"
              value={phone}
              onChangeText={setPhone}
              placeholder="+1 555 123 4567"
              keyboardType="phone-pad"
              placeholderTextColor={Colors.textTertiary}
              style={styles.input}
            />
          </Field>

          <Text style={styles.label}>Gender</Text>
          <View style={styles.genderRow}>
            {GENDERS.map(g => (
              <TouchableOpacity
                key={g}
                testID={`gender-${g.toLowerCase()}`}
                onPress={() => setGender(g)}
                activeOpacity={0.85}
                style={[styles.genderPill, gender === g && styles.genderPillActive]}
              >
                <Text style={[styles.genderText, gender === g && styles.genderTextActive]}>{g}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <TouchableOpacity testID="add-member-submit" onPress={onSubmit} activeOpacity={0.85} style={styles.cta} disabled={loading}>
            {loading ? <ActivityIndicator color={Colors.surface} /> : <Text style={styles.ctaText}>Add Member</Text>}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>

      <Modal
        visible={!!paywallMsg}
        transparent
        animationType="fade"
        onRequestClose={() => setPaywallMsg(null)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard} testID="paywall-modal">
            <Text style={styles.modalEmoji}>⭐</Text>
            <Text style={styles.modalTitle}>Upgrade to add more members</Text>
            <Text style={styles.modalBody}>
              {paywallMsg || 'You\'ve reached the free plan limit. Upgrade to add unlimited family members.'}
            </Text>
            <TouchableOpacity
              testID="paywall-see-plans"
              style={styles.modalPrimary}
              onPress={() => { setPaywallMsg(null); router.push('/upgrade'); }}
              activeOpacity={0.85}
            >
              <Text style={styles.modalPrimaryText}>See Plans</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="paywall-dismiss"
              style={styles.modalSecondary}
              onPress={() => setPaywallMsg(null)}
              activeOpacity={0.7}
            >
              <Text style={styles.modalSecondaryText}>Maybe later</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function Field({ label, testID, children }: any) {
  return (
    <View testID={testID} style={{ marginTop: 16 }}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8 },
  iconBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border },
  title: { fontSize: 18, fontWeight: '700', color: Colors.textPrimary },
  subtitle: { fontSize: 15, color: Colors.textSecondary, lineHeight: 22, marginBottom: 8 },
  label: { fontSize: 13, fontWeight: '700', color: Colors.textSecondary, marginBottom: 8, marginTop: 16, textTransform: 'uppercase', letterSpacing: 0.6 },
  input: {
    backgroundColor: Colors.surface, borderRadius: 14, padding: 16, fontSize: 16,
    color: Colors.textPrimary, borderWidth: 1, borderColor: Colors.border,
  },
  genderRow: { flexDirection: 'row', gap: 10 },
  genderPill: {
    flex: 1, height: 52, borderRadius: 14, backgroundColor: Colors.surface,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: Colors.border,
  },
  genderPillActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  genderText: { fontSize: 15, fontWeight: '600', color: Colors.textSecondary },
  genderTextActive: { color: Colors.surface },
  cta: {
    marginTop: 32, height: 60, backgroundColor: Colors.primary, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
  },
  ctaText: { color: Colors.surface, fontSize: 17, fontWeight: '700' },
  modalBackdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center', justifyContent: 'center', padding: 24,
  },
  modalCard: {
    width: '100%', maxWidth: 360, backgroundColor: Colors.surface,
    borderRadius: 18, padding: 22, alignItems: 'center',
    boxShadow: '0px 12px 28px rgba(0,0,0,0.22)' as any,
  },
  modalEmoji: { fontSize: 36, marginBottom: 4 },
  modalTitle: { fontSize: 18, fontWeight: '800', color: Colors.textPrimary, textAlign: 'center' },
  modalBody: {
    fontSize: 14, color: Colors.textSecondary, textAlign: 'center',
    marginTop: 8, marginBottom: 20, lineHeight: 20,
  },
  modalPrimary: {
    height: 50, alignSelf: 'stretch', backgroundColor: Colors.primary,
    borderRadius: 14, alignItems: 'center', justifyContent: 'center',
  },
  modalPrimaryText: { color: Colors.surface, fontSize: 16, fontWeight: '800' },
  modalSecondary: { marginTop: 10, alignSelf: 'stretch', alignItems: 'center', paddingVertical: 12 },
  modalSecondaryText: { color: Colors.textSecondary, fontSize: 15, fontWeight: '600' },
});
