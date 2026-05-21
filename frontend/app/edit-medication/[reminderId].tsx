import { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, ScrollView,
  KeyboardAvoidingView, Platform, Alert, ActivityIndicator,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Icon } from '../../src/Icon';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors } from '../../src/theme';
import { api, TimeSlot, Reminder } from '../../src/api';
import { TimeSlotsEditor, isValidHHMM } from '../../src/TimeSlotsEditor';

export default function EditMedication() {
  const router = useRouter();
  const { reminderId } = useLocalSearchParams<{ reminderId: string }>();
  const [name, setName] = useState('');
  const [dosage, setDosage] = useState('');
  const [slots, setSlots] = useState<TimeSlot[]>([]);
  const [category, setCategory] = useState<'medication' | 'routine'>('medication');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refillEnabled, setRefillEnabled] = useState(false);
  const [daysSupplyStr, setDaysSupplyStr] = useState('30');
  const [leadTimeStr, setLeadTimeStr] = useState('7');
  const [lastRefillIso, setLastRefillIso] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        // We don't have GET /reminders/{id} so fetch all and find
        const r = await api.get('/reminders');
        const found: Reminder | undefined = (r.data as Reminder[]).find(x => x.id === reminderId);
        if (found) {
          setName(found.title);
          setDosage(found.dosage || '');
          setSlots(found.times.length > 0 ? found.times : [{ time: '08:00', label: null }]);
          setCategory(found.category);
          if (found.days_supply) {
            setRefillEnabled(true);
            setDaysSupplyStr(String(found.days_supply));
            setLeadTimeStr(String(found.refill_reminder_days || 7));
            setLastRefillIso(found.last_refill_at || null);
          }
        }
      } catch (_e) {}
      setLoading(false);
    })();
  }, [reminderId]);

  const onSubmit = async () => {
    if (!name.trim()) { Alert.alert('Missing', 'Enter a name.'); return; }
    if (slots.length === 0) { Alert.alert('Missing', 'Add at least one time.'); return; }
    for (const s of slots) {
      if (!isValidHHMM(s.time)) {
        Alert.alert('Invalid time', `"${s.time}" is not a valid HH:MM time.`);
        return;
      }
    }
    let days_supply: number | null = null;
    let refill_reminder_days: number | null = null;
    if (!isRoutine && refillEnabled) {
      const d = parseInt(daysSupplyStr, 10);
      const l = parseInt(leadTimeStr, 10);
      if (!Number.isFinite(d) || d <= 0 || d > 365) {
        Alert.alert('Invalid days supply', 'Enter a number between 1 and 365.');
        return;
      }
      if (!Number.isFinite(l) || l <= 0 || l > d) {
        Alert.alert('Invalid lead time', 'Refill lead time must be between 1 and the days supply.');
        return;
      }
      days_supply = d;
      refill_reminder_days = l;
    } else if (!isRoutine && !refillEnabled) {
      // explicitly turn refill off
      days_supply = 0;
    }
    setSaving(true);
    try {
      const payload: any = {
        title: name.trim(),
        dosage: dosage.trim() || null,
        times: slots.map(s => ({ time: s.time, label: s.label || null })),
      };
      if (!isRoutine) {
        payload.days_supply = days_supply;
        payload.refill_reminder_days = refill_reminder_days;
      }
      await api.put(`/reminders/${reminderId}`, payload);
      router.back();
    } catch (e: any) {
      Alert.alert('Failed', e?.response?.data?.detail || 'Try again.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator color={Colors.primary} size="large" />
        </View>
      </SafeAreaView>
    );
  }

  const isRoutine = category === 'routine';

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <View style={styles.header}>
          <TouchableOpacity testID="edit-med-close" onPress={() => router.back()} style={styles.iconBtn}>
            <Icon name="close" size={26} color={Colors.textPrimary} />
          </TouchableOpacity>
          <Text style={styles.title}>{isRoutine ? '🌿 Edit Routine' : '💊 Edit Medication'}</Text>
          <View style={{ width: 44 }} />
        </View>

        <ScrollView contentContainerStyle={{ padding: 24, paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
          <Text style={styles.label}>{isRoutine ? 'Routine name' : 'Medication name'}</Text>
          <TextInput
            testID="edit-med-name"
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholderTextColor={Colors.textTertiary}
          />

          {!isRoutine && (
            <>
              <Text style={styles.label}>Dosage (optional)</Text>
              <TextInput
                testID="edit-med-dosage"
                style={styles.input}
                value={dosage}
                onChangeText={setDosage}
                placeholder="e.g. 500mg, 1 pill"
                placeholderTextColor={Colors.textTertiary}
              />
            </>
          )}

          <Text style={styles.label}>Reminder times</Text>
          <Text style={styles.subhelp}>Edit, add, or remove times — each can have an optional label.</Text>
          <TimeSlotsEditor slots={slots} onChange={setSlots} testIDPrefix="edit-med" />

          {!isRoutine && (
            <View style={styles.refillSection}>
              <View style={styles.refillHeader}>
                <Text style={styles.refillTitle}>🔄 Refill reminder</Text>
                <TouchableOpacity
                  testID="edit-med-refill-toggle"
                  onPress={() => setRefillEnabled((v) => !v)}
                  activeOpacity={0.85}
                  style={[styles.refillToggle, refillEnabled && styles.refillToggleOn]}
                >
                  <Text style={[styles.refillToggleText, refillEnabled && { color: Colors.surface }]}>
                    {refillEnabled ? 'ON' : 'OFF'}
                  </Text>
                </TouchableOpacity>
              </View>
              {refillEnabled && (
                <View>
                  <Text style={styles.label}>Days supply</Text>
                  <TextInput
                    testID="edit-med-days-supply"
                    value={daysSupplyStr}
                    onChangeText={setDaysSupplyStr}
                    keyboardType="number-pad"
                    maxLength={3}
                    placeholder="30"
                    placeholderTextColor={Colors.textTertiary}
                    style={styles.input}
                  />
                  <Text style={styles.label}>Remind me … days before run-out</Text>
                  <TextInput
                    testID="edit-med-lead-time"
                    value={leadTimeStr}
                    onChangeText={setLeadTimeStr}
                    keyboardType="number-pad"
                    maxLength={3}
                    placeholder="7"
                    placeholderTextColor={Colors.textTertiary}
                    style={styles.input}
                  />
                  {lastRefillIso && (
                    <Text style={styles.lastRefillHint}>
                      Last refilled: {new Date(lastRefillIso).toLocaleDateString(undefined, {
                        weekday: 'short', month: 'short', day: 'numeric',
                      })}
                    </Text>
                  )}
                </View>
              )}
            </View>
          )}

          <TouchableOpacity
            testID="edit-med-submit"
            onPress={onSubmit}
            activeOpacity={0.85}
            style={styles.cta}
            disabled={saving}
          >
            {saving ? <ActivityIndicator color={Colors.surface} /> : <Text style={styles.ctaText}>Save Changes</Text>}
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
  refillSection: {
    marginTop: 22, padding: 16,
    backgroundColor: Colors.surface, borderRadius: 16,
    borderWidth: 1, borderColor: Colors.border,
  },
  refillHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  refillTitle: { fontSize: 16, fontWeight: '800', color: Colors.textPrimary },
  refillToggle: {
    paddingHorizontal: 14, paddingVertical: 6, borderRadius: 999,
    backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border,
  },
  refillToggleOn: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  refillToggleText: { fontSize: 12, fontWeight: '800', color: Colors.textSecondary, letterSpacing: 0.5 },
  lastRefillHint: { marginTop: 10, fontSize: 12, color: Colors.textSecondary },
});
