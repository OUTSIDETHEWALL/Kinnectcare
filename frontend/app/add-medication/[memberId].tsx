import { useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, ScrollView,
  KeyboardAvoidingView, Platform, Alert, ActivityIndicator,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Icon } from '../../src/Icon';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors } from '../../src/theme';
import { api } from '../../src/api';

const SLOTS: { label: string; emoji: string; time: string }[] = [
  { label: 'Morning', emoji: '🌅', time: '08:00' },
  { label: 'Afternoon', emoji: '☀️', time: '13:00' },
  { label: 'Evening', emoji: '🌇', time: '18:00' },
  { label: 'Bedtime', emoji: '🌙', time: '21:00' },
];

export default function AddMedication() {
  const router = useRouter();
  const { memberId } = useLocalSearchParams<{ memberId: string }>();
  const [name, setName] = useState('');
  const [dosage, setDosage] = useState('');
  const [selected, setSelected] = useState<string[]>(['08:00']);
  const [loading, setLoading] = useState(false);

  const toggle = (t: string) => {
    setSelected(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t].sort());
  };

  const onSubmit = async () => {
    if (!name.trim()) { Alert.alert('Missing', 'Enter medication name.'); return; }
    if (selected.length === 0) { Alert.alert('Missing', 'Select at least one reminder time.'); return; }
    setLoading(true);
    try {
      await api.post('/reminders', {
        member_id: memberId,
        title: name.trim(),
        dosage: dosage.trim() || null,
        category: 'medication',
        times: selected,
      });
      router.back();
    } catch (e: any) {
      Alert.alert('Failed', e?.response?.data?.detail || 'Try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <View style={styles.header}>
          <TouchableOpacity testID="add-med-close" onPress={() => router.back()} style={styles.iconBtn}>
            <Icon name="close" size={22} color={Colors.textPrimary} />
          </TouchableOpacity>
          <Text style={styles.title}>💊 Add Medication</Text>
          <View style={{ width: 44 }} />
        </View>

        <ScrollView contentContainerStyle={{ padding: 24 }} keyboardShouldPersistTaps="handled">
          <Text style={styles.label}>Medication name</Text>
          <TextInput
            testID="med-name"
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="e.g. Metformin"
            placeholderTextColor={Colors.textTertiary}
          />

          <Text style={styles.label}>Dosage (optional)</Text>
          <TextInput
            testID="med-dosage"
            style={styles.input}
            value={dosage}
            onChangeText={setDosage}
            placeholder="e.g. 500mg, 1 pill"
            placeholderTextColor={Colors.textTertiary}
          />

          <Text style={styles.label}>Reminder times</Text>
          <View style={styles.slotsGrid}>
            {SLOTS.map(s => {
              const active = selected.includes(s.time);
              return (
                <TouchableOpacity
                  key={s.time}
                  testID={`slot-${s.label.toLowerCase()}`}
                  onPress={() => toggle(s.time)}
                  activeOpacity={0.85}
                  style={[styles.slot, active && styles.slotActive]}
                >
                  <Text style={styles.slotEmoji}>{s.emoji}</Text>
                  <Text style={[styles.slotLabel, active && styles.slotLabelActive]}>{s.label}</Text>
                  <Text style={[styles.slotTime, active && { color: Colors.surface }]}>{s.time}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <TouchableOpacity
            testID="add-med-submit"
            onPress={onSubmit}
            activeOpacity={0.85}
            style={styles.cta}
            disabled={loading}
          >
            {loading ? <ActivityIndicator color={Colors.surface} /> : <Text style={styles.ctaText}>Add Medication</Text>}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8 },
  iconBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border },
  title: { fontSize: 18, fontWeight: '700', color: Colors.textPrimary },
  label: { fontSize: 13, fontWeight: '700', color: Colors.textSecondary, marginTop: 18, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.6 },
  input: { backgroundColor: Colors.surface, borderRadius: 14, padding: 16, fontSize: 16, color: Colors.textPrimary, borderWidth: 1, borderColor: Colors.border },
  slotsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  slot: {
    flexBasis: '47%', flexGrow: 1, padding: 14, backgroundColor: Colors.surface,
    borderRadius: 14, borderWidth: 1, borderColor: Colors.border, alignItems: 'center',
  },
  slotActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  slotEmoji: { fontSize: 22, marginBottom: 4 },
  slotLabel: { fontSize: 14, fontWeight: '700', color: Colors.textSecondary },
  slotLabelActive: { color: Colors.surface },
  slotTime: { fontSize: 12, color: Colors.textTertiary, marginTop: 2 },
  cta: { marginTop: 28, height: 58, backgroundColor: Colors.primary, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  ctaText: { color: Colors.surface, fontSize: 17, fontWeight: '700' },
});
