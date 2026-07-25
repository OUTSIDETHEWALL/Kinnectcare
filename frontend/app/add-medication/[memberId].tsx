import { useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, ScrollView,
  KeyboardAvoidingView, Platform, Alert, ActivityIndicator,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Icon } from '../../src/Icon';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors } from '../../src/theme';
import { api, TimeSlot } from '../../src/api';
import { TimeSlotsEditor, isValidHHMM } from '../../src/TimeSlotsEditor';

export default function AddMedication() {
  const router = useRouter();
  const { memberId } = useLocalSearchParams<{ memberId: string }>();
  const [name, setName] = useState('');
  const [dosage, setDosage] = useState('');
  const [slots, setSlots] = useState<TimeSlot[]>([{ time: '08:00', label: 'Morning' }]);
  const [loading, setLoading] = useState(false);

  const onSubmit = async () => {
    if (!name.trim()) { Alert.alert('Missing', 'Enter medication name.'); return; }
    if (slots.length === 0) { Alert.alert('Missing', 'Add at least one reminder time.'); return; }
    for (const s of slots) {
      if (!isValidHHMM(s.time)) {
        Alert.alert('Invalid time', `"${s.time}" is not a valid HH:MM time.`);
        return;
      }
    }
    setLoading(true);
    try {
      await api.post('/reminders', {
        member_id: memberId,
        title: name.trim(),
        dosage: dosage.trim() || null,
        category: 'medication',
        times: slots.map(s => ({ time: s.time, label: s.label || null })),
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
            <Icon name="close" size={26} color={Colors.textPrimary} />
          </TouchableOpacity>
          <Text style={styles.title}>💊 Add Medication</Text>
          <View style={{ width: 44 }} />
        </View>

        <ScrollView contentContainerStyle={{ padding: 24, paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
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
          <Text style={styles.subhelp}>Add as many custom times as you need. Each time has an optional label.</Text>
          <TimeSlotsEditor slots={slots} onChange={setSlots} testIDPrefix="add-med" />

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
  iconBtn: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border },
  title: { fontSize: 18, fontWeight: '700', color: Colors.textPrimary },
  label: { fontSize: 13, fontWeight: '700', color: Colors.textSecondary, marginTop: 18, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.6 },
  subhelp: { fontSize: 13, color: Colors.textTertiary, marginBottom: 12, marginTop: -4 },
  input: { backgroundColor: Colors.surface, borderRadius: 14, padding: 16, fontSize: 16, color: Colors.textPrimary, borderWidth: 1, borderColor: Colors.border },
  cta: { marginTop: 28, height: 58, backgroundColor: Colors.primary, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  ctaText: { color: Colors.surface, fontSize: 17, fontWeight: '700' },
});
