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

const PRESETS: { label: string; emoji: string; suggested: string }[] = [
  { label: 'Drink water', emoji: '💧', suggested: '10:00' },
  { label: 'Morning walk', emoji: '🚶', suggested: '07:30' },
  { label: 'Breakfast', emoji: '🍳', suggested: '08:30' },
  { label: 'Lunch', emoji: '🥗', suggested: '12:30' },
  { label: 'Dinner', emoji: '🍽', suggested: '19:00' },
  { label: 'Stretching', emoji: '🧘', suggested: '17:00' },
];

const TIME_PRESETS = ['07:00', '08:30', '10:00', '12:30', '15:00', '17:00', '19:00', '21:00'];

export default function AddRoutine() {
  const router = useRouter();
  const { memberId } = useLocalSearchParams<{ memberId: string }>();
  const [title, setTitle] = useState('');
  const [time, setTime] = useState('10:00');
  const [loading, setLoading] = useState(false);

  const pickPreset = (p: { label: string; suggested: string }) => {
    setTitle(p.label);
    setTime(p.suggested);
  };

  const onSubmit = async () => {
    if (!title.trim()) { Alert.alert('Missing', 'Enter a routine name.'); return; }
    setLoading(true);
    try {
      await api.post('/reminders', {
        member_id: memberId,
        title: title.trim(),
        category: 'routine',
        times: [time],
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
          <TouchableOpacity testID="add-routine-close" onPress={() => router.back()} style={styles.iconBtn}>
            <Icon name="close" size={22} color={Colors.textPrimary} />
          </TouchableOpacity>
          <Text style={styles.title}>🌿 Add Routine</Text>
          <View style={{ width: 44 }} />
        </View>

        <ScrollView contentContainerStyle={{ padding: 24 }} keyboardShouldPersistTaps="handled">
          <Text style={styles.label}>Quick picks</Text>
          <View style={styles.presetGrid}>
            {PRESETS.map(p => (
              <TouchableOpacity
                key={p.label}
                testID={`preset-${p.label.toLowerCase().replace(/\s/g, '-')}`}
                onPress={() => pickPreset(p)}
                style={[styles.preset, title === p.label && styles.presetActive]}
                activeOpacity={0.85}
              >
                <Text style={styles.presetEmoji}>{p.emoji}</Text>
                <Text style={[styles.presetText, title === p.label && { color: Colors.surface }]}>{p.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.label}>Or custom name</Text>
          <TextInput
            testID="routine-title"
            style={styles.input}
            value={title}
            onChangeText={setTitle}
            placeholder="e.g. Read for 20 minutes"
            placeholderTextColor={Colors.textTertiary}
          />

          <Text style={styles.label}>Time</Text>
          <View style={styles.timeRow}>
            {TIME_PRESETS.map(t => (
              <TouchableOpacity
                key={t}
                testID={`routine-time-${t}`}
                onPress={() => setTime(t)}
                style={[styles.timePill, time === t && styles.timePillActive]}
              >
                <Text style={[styles.timePillText, time === t && { color: Colors.surface }]}>{t}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <TouchableOpacity
            testID="add-routine-submit"
            onPress={onSubmit}
            activeOpacity={0.85}
            style={styles.cta}
            disabled={loading}
          >
            {loading ? <ActivityIndicator color={Colors.surface} /> : <Text style={styles.ctaText}>Add Routine</Text>}
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
  presetGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  preset: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 999, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border },
  presetActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  presetEmoji: { fontSize: 16 },
  presetText: { fontWeight: '700', color: Colors.textSecondary, fontSize: 13 },
  timeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  timePill: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 999, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border },
  timePillActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  timePillText: { fontWeight: '700', color: Colors.textSecondary, fontSize: 13 },
  cta: { marginTop: 28, height: 58, backgroundColor: Colors.primary, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  ctaText: { color: Colors.surface, fontSize: 17, fontWeight: '700' },
});
