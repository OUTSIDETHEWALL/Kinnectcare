import { useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, ScrollView,
  KeyboardAvoidingView, Platform, Alert, ActivityIndicator,
} from 'react-native';
import { Colors } from './theme';
import { TimeSlot } from './api';

export const LABEL_PRESETS: { label: string; emoji: string; suggested: string }[] = [
  { label: 'Morning', emoji: '🌅', suggested: '08:00' },
  { label: 'Afternoon', emoji: '☀️', suggested: '13:00' },
  { label: 'Evening', emoji: '🌇', suggested: '18:00' },
  { label: 'Bedtime', emoji: '🌙', suggested: '21:00' },
];

export function emojiFor(label?: string | null): string {
  const found = LABEL_PRESETS.find(p => p.label === label);
  return found ? found.emoji : '🕐';
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

export function isValidHHMM(s: string): boolean {
  if (!/^\d{2}:\d{2}$/.test(s)) return false;
  const [h, m] = s.split(':').map(Number);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

function clampHour(s: string): string {
  const n = parseInt(s, 10);
  if (isNaN(n)) return '';
  return pad(Math.min(23, Math.max(0, n)));
}

function clampMin(s: string): string {
  const n = parseInt(s, 10);
  if (isNaN(n)) return '';
  return pad(Math.min(59, Math.max(0, n)));
}

type Props = {
  slots: TimeSlot[];
  onChange: (next: TimeSlot[]) => void;
  testIDPrefix?: string;
};

export function TimeSlotsEditor({ slots, onChange, testIDPrefix = 'slot' }: Props) {
  const add = () => {
    const next: TimeSlot = { time: '08:00', label: null };
    onChange([...slots, next]);
  };
  const remove = (i: number) => {
    onChange(slots.filter((_, idx) => idx !== i));
  };
  const update = (i: number, patch: Partial<TimeSlot>) => {
    onChange(slots.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  };

  return (
    <View>
      {slots.length === 0 && (
        <Text style={styles.emptyHint}>No times yet. Tap "+ Add Time" below to add one.</Text>
      )}
      {slots.map((s, i) => (
        <TimeRow
          key={i}
          slot={s}
          index={i}
          canRemove={slots.length > 1}
          onRemove={() => remove(i)}
          onChange={(p) => update(i, p)}
          testIDPrefix={testIDPrefix}
        />
      ))}
      <TouchableOpacity
        testID={`${testIDPrefix}-add-time`}
        onPress={add}
        activeOpacity={0.85}
        style={styles.addRow}
      >
        <Text style={styles.addRowText}>➕ Add Time</Text>
      </TouchableOpacity>
    </View>
  );
}

function TimeRow({ slot, index, canRemove, onRemove, onChange, testIDPrefix }: {
  slot: TimeSlot;
  index: number;
  canRemove: boolean;
  onRemove: () => void;
  onChange: (p: Partial<TimeSlot>) => void;
  testIDPrefix: string;
}) {
  const [h, m] = slot.time.split(':');
  const [hStr, setHStr] = useState(h || '08');
  const [mStr, setMStr] = useState(m || '00');

  const commitH = (raw: string) => {
    const cleaned = clampHour(raw.replace(/[^\d]/g, '').slice(0, 2));
    setHStr(cleaned);
    onChange({ time: `${cleaned || '00'}:${mStr || '00'}` });
  };
  const commitM = (raw: string) => {
    const cleaned = clampMin(raw.replace(/[^\d]/g, '').slice(0, 2));
    setMStr(cleaned);
    onChange({ time: `${hStr || '00'}:${cleaned || '00'}` });
  };

  return (
    <View testID={`${testIDPrefix}-row-${index}`} style={styles.rowCard}>
      <View style={styles.rowHeader}>
        <Text style={styles.rowEmoji}>{emojiFor(slot.label)}</Text>
        <Text style={styles.rowTitle}>Time {index + 1}</Text>
        {canRemove && (
          <TouchableOpacity
            testID={`${testIDPrefix}-remove-${index}`}
            onPress={onRemove}
            style={styles.removeBtn}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.removeText}>✕</Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.timeInputRow}>
        <TextInput
          testID={`${testIDPrefix}-hour-${index}`}
          value={hStr}
          onChangeText={setHStr}
          onBlur={() => commitH(hStr)}
          onEndEditing={() => commitH(hStr)}
          keyboardType="number-pad"
          maxLength={2}
          placeholder="HH"
          placeholderTextColor={Colors.textTertiary}
          style={styles.timeInput}
        />
        <Text style={styles.colon}>:</Text>
        <TextInput
          testID={`${testIDPrefix}-minute-${index}`}
          value={mStr}
          onChangeText={setMStr}
          onBlur={() => commitM(mStr)}
          onEndEditing={() => commitM(mStr)}
          keyboardType="number-pad"
          maxLength={2}
          placeholder="MM"
          placeholderTextColor={Colors.textTertiary}
          style={styles.timeInput}
        />
      </View>

      <Text style={styles.labelHint}>Label (optional)</Text>
      <View style={styles.labelRow}>
        {LABEL_PRESETS.map((p) => {
          const active = slot.label === p.label;
          return (
            <TouchableOpacity
              key={p.label}
              testID={`${testIDPrefix}-label-${p.label.toLowerCase()}-${index}`}
              onPress={() => onChange({ label: active ? null : p.label })}
              activeOpacity={0.85}
              style={[styles.labelPill, active && styles.labelPillActive]}
            >
              <Text style={styles.labelPillEmoji}>{p.emoji}</Text>
              <Text style={[styles.labelPillText, active && { color: Colors.surface }]}>{p.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  emptyHint: { color: Colors.textTertiary, fontSize: 13, fontStyle: 'italic', textAlign: 'center', paddingVertical: 12 },
  rowCard: {
    backgroundColor: Colors.surface, borderRadius: 16, padding: 14, marginBottom: 10,
    borderWidth: 1, borderColor: Colors.border,
  },
  rowHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  rowEmoji: { fontSize: 18 },
  rowTitle: { flex: 1, fontSize: 14, fontWeight: '700', color: Colors.textSecondary, marginLeft: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  removeBtn: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.errorBg },
  removeText: { color: Colors.error, fontWeight: '800', fontSize: 14 },
  timeInputRow: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', backgroundColor: Colors.background, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1, borderColor: Colors.border },
  timeInput: { fontSize: 26, fontWeight: '700', color: Colors.textPrimary, width: 48, textAlign: 'center' },
  colon: { fontSize: 26, fontWeight: '700', color: Colors.textSecondary, marginHorizontal: 4 },
  labelHint: { fontSize: 11, fontWeight: '700', color: Colors.textTertiary, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 12, marginBottom: 6 },
  labelRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  labelPill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border },
  labelPillActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  labelPillEmoji: { fontSize: 13 },
  labelPillText: { fontSize: 12, fontWeight: '700', color: Colors.textSecondary },
  addRow: { paddingVertical: 14, borderRadius: 14, backgroundColor: Colors.tertiary, alignItems: 'center', marginTop: 4 },
  addRowText: { color: Colors.primary, fontWeight: '700', fontSize: 14 },
});
