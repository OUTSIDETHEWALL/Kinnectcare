import { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput } from 'react-native';
import { Colors } from './theme';
import { parseHHMM, to12Hour, to24Hour } from './timeFormat';

/**
 * 12-hour time picker — hour (1-12), minute (0-59), AM/PM toggle.
 * Emits a canonical "HH:MM" 24-hour string via onChange whenever the value
 * is valid.
 */
type Props = {
  value?: string | null; // "HH:MM" 24h, optional
  onChange: (hhmm: string) => void;
  testIDPrefix?: string;
  defaultHour?: number; // 1-12
  defaultMinute?: number;
  defaultAmPm?: 'AM' | 'PM';
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}
function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

export function TimePicker12({
  value,
  onChange,
  testIDPrefix = 'time-picker',
  defaultHour = 8,
  defaultMinute = 0,
  defaultAmPm = 'AM',
}: Props) {
  const initial = (() => {
    const parsed = parseHHMM(value || '');
    if (parsed) {
      const { hour12, ampm } = to12Hour(parsed.hour24);
      return { hour12, minute: parsed.minute, ampm };
    }
    return { hour12: defaultHour, minute: defaultMinute, ampm: defaultAmPm };
  })();

  const [hour12, setHour12] = useState<number>(initial.hour12);
  const [minute, setMinute] = useState<number>(initial.minute);
  const [ampm, setAmpm] = useState<'AM' | 'PM'>(initial.ampm);
  const [hourStr, setHourStr] = useState<string>(`${initial.hour12}`);
  const [minStr, setMinStr] = useState<string>(pad2(initial.minute));

  // Re-sync from external value when it changes.
  useEffect(() => {
    const parsed = parseHHMM(value || '');
    if (!parsed) return;
    const { hour12: h12, ampm: ap } = to12Hour(parsed.hour24);
    setHour12(h12);
    setMinute(parsed.minute);
    setAmpm(ap);
    setHourStr(`${h12}`);
    setMinStr(pad2(parsed.minute));
  }, [value]);

  // Emit whenever any axis changes.
  const emit = (h: number, m: number, ap: 'AM' | 'PM') => {
    const hh = clamp(h, 1, 12);
    const mm = clamp(m, 0, 59);
    onChange(to24Hour(hh, mm, ap));
  };

  const commitHour = (raw: string) => {
    const n = parseInt(raw.replace(/[^\d]/g, ''), 10);
    const safe = Number.isFinite(n) ? clamp(n, 1, 12) : 1;
    setHour12(safe);
    setHourStr(`${safe}`);
    emit(safe, minute, ampm);
  };
  const commitMinute = (raw: string) => {
    const n = parseInt(raw.replace(/[^\d]/g, ''), 10);
    const safe = Number.isFinite(n) ? clamp(n, 0, 59) : 0;
    setMinute(safe);
    setMinStr(pad2(safe));
    emit(hour12, safe, ampm);
  };
  const switchAmPm = (next: 'AM' | 'PM') => {
    setAmpm(next);
    emit(hour12, minute, next);
  };

  return (
    <View style={styles.row} testID={testIDPrefix}>
      <TextInput
        testID={`${testIDPrefix}-hour`}
        value={hourStr}
        onChangeText={setHourStr}
        onBlur={() => commitHour(hourStr)}
        onEndEditing={() => commitHour(hourStr)}
        keyboardType="number-pad"
        maxLength={2}
        placeholder="H"
        placeholderTextColor={Colors.textTertiary}
        style={styles.numInput}
      />
      <Text style={styles.colon}>:</Text>
      <TextInput
        testID={`${testIDPrefix}-minute`}
        value={minStr}
        onChangeText={setMinStr}
        onBlur={() => commitMinute(minStr)}
        onEndEditing={() => commitMinute(minStr)}
        keyboardType="number-pad"
        maxLength={2}
        placeholder="MM"
        placeholderTextColor={Colors.textTertiary}
        style={styles.numInput}
      />
      <View style={styles.ampmToggle}>
        <TouchableOpacity
          testID={`${testIDPrefix}-am`}
          onPress={() => switchAmPm('AM')}
          activeOpacity={0.85}
          style={[styles.ampmBtn, ampm === 'AM' && styles.ampmBtnActive]}
        >
          <Text style={[styles.ampmText, ampm === 'AM' && styles.ampmTextActive]}>AM</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID={`${testIDPrefix}-pm`}
          onPress={() => switchAmPm('PM')}
          activeOpacity={0.85}
          style={[styles.ampmBtn, ampm === 'PM' && styles.ampmBtnActive]}
        >
          <Text style={[styles.ampmText, ampm === 'PM' && styles.ampmTextActive]}>PM</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: Colors.background,
    borderRadius: 12,
    paddingHorizontal: 10, paddingVertical: 6,
    borderWidth: 1, borderColor: Colors.border,
    gap: 6,
  },
  numInput: {
    fontSize: 24, fontWeight: '700', color: Colors.textPrimary,
    width: 44, textAlign: 'center',
  },
  colon: { fontSize: 24, fontWeight: '700', color: Colors.textSecondary, marginHorizontal: 2 },
  ampmToggle: {
    marginLeft: 8,
    flexDirection: 'row',
    borderRadius: 10,
    backgroundColor: Colors.surface,
    borderWidth: 1, borderColor: Colors.border,
    overflow: 'hidden',
  },
  ampmBtn: {
    paddingHorizontal: 12, paddingVertical: 8,
    minWidth: 44, alignItems: 'center', justifyContent: 'center',
  },
  ampmBtnActive: { backgroundColor: Colors.primary },
  ampmText: { fontSize: 13, fontWeight: '700', color: Colors.textSecondary },
  ampmTextActive: { color: Colors.surface },
});
