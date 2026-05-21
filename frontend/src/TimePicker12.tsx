import { useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, Platform, Modal,
} from 'react-native';
import { Colors } from './theme';
import { parseHHMM, to12Hour, to24Hour, formatTime12 } from './timeFormat';

let DateTimePicker: any = null;
let DateTimePickerAndroid: any = null;
if (Platform.OS !== 'web') {
  // Lazy require so web bundles never need to resolve native bits.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@react-native-community/datetimepicker');
    DateTimePicker = mod.default || mod;
    DateTimePickerAndroid = mod.DateTimePickerAndroid;
  } catch (_e) {
    DateTimePicker = null;
  }
}

/**
 * 12-hour time picker.
 *
 *   • iOS    — taps into a native spinner-wheel inside a centered modal
 *              (uses display="spinner").
 *   • Android — pops the system clock dialog via DateTimePickerAndroid.
 *   • Web    — falls back to an inline hour/minute number field with an
 *              AM/PM toggle (the previous implementation).
 *
 * The component always EMITS a canonical "HH:MM" 24-hour string via
 * onChange, so it's a drop-in replacement everywhere.
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

function hhmmToDate(hhmm?: string | null, fallback?: { h: number; m: number }): Date {
  const d = new Date();
  d.setSeconds(0, 0);
  const parsed = parseHHMM(hhmm || '');
  if (parsed) {
    d.setHours(parsed.hour24, parsed.minute, 0, 0);
  } else if (fallback) {
    d.setHours(fallback.h, fallback.m, 0, 0);
  }
  return d;
}

function dateToHHMM(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function TimePicker12({
  value,
  onChange,
  testIDPrefix = 'time-picker',
  defaultHour = 8,
  defaultMinute = 0,
  defaultAmPm = 'AM',
}: Props) {
  // Compute the initial Date once.
  const fallback24 = useMemo(() => {
    let h = defaultHour % 12;
    if (defaultAmPm === 'PM') h += 12;
    return { h, m: defaultMinute };
  }, [defaultHour, defaultMinute, defaultAmPm]);

  const [iosOpen, setIosOpen] = useState(false);
  const [iosDraft, setIosDraft] = useState<Date>(() => hhmmToDate(value, fallback24));

  useEffect(() => {
    // Keep the iOS draft in sync if the parent changes value externally.
    setIosDraft(hhmmToDate(value, fallback24));
  }, [value, fallback24]);

  // -------- Web fallback (inline custom picker) --------
  if (Platform.OS === 'web' || !DateTimePicker) {
    return (
      <WebInlinePicker
        value={value}
        onChange={onChange}
        testIDPrefix={testIDPrefix}
        defaultHour={defaultHour}
        defaultMinute={defaultMinute}
        defaultAmPm={defaultAmPm}
      />
    );
  }

  const displayLabel = value
    ? formatTime12(value)
    : formatTime12(`${pad2(fallback24.h)}:${pad2(fallback24.m)}`);

  // -------- Android: tap → system clock dialog --------
  if (Platform.OS === 'android') {
    const open = () => {
      try {
        DateTimePickerAndroid.open({
          value: hhmmToDate(value, fallback24),
          mode: 'time',
          is24Hour: false, // honours device locale but we render 12h
          display: 'clock',
          onChange: (event: any, selected?: Date) => {
            if (event?.type === 'set' && selected) {
              onChange(dateToHHMM(selected));
            }
          },
        });
      } catch (_e) {
        // graceful no-op
      }
    };
    return (
      <TouchableOpacity
        testID={testIDPrefix}
        onPress={open}
        activeOpacity={0.85}
        style={styles.fieldButton}
      >
        <Text style={styles.fieldButtonText}>{displayLabel}</Text>
        <Text style={styles.fieldButtonHint}>Tap to change ▾</Text>
      </TouchableOpacity>
    );
  }

  // -------- iOS: tap → modal with spinner wheel + Done/Cancel --------
  const openIosModal = () => {
    setIosDraft(hhmmToDate(value, fallback24));
    setIosOpen(true);
  };
  const confirmIos = () => {
    onChange(dateToHHMM(iosDraft));
    setIosOpen(false);
  };
  const cancelIos = () => {
    setIosOpen(false);
  };

  return (
    <View>
      <TouchableOpacity
        testID={testIDPrefix}
        onPress={openIosModal}
        activeOpacity={0.85}
        style={styles.fieldButton}
      >
        <Text style={styles.fieldButtonText}>{displayLabel}</Text>
        <Text style={styles.fieldButtonHint}>Tap to change ▾</Text>
      </TouchableOpacity>

      <Modal
        transparent
        visible={iosOpen}
        animationType="fade"
        onRequestClose={cancelIos}
      >
        <View style={styles.iosBackdrop}>
          <View style={styles.iosSheet}>
            <View style={styles.iosToolbar}>
              <TouchableOpacity
                testID={`${testIDPrefix}-cancel`}
                onPress={cancelIos}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={styles.iosToolbarBtn}>Cancel</Text>
              </TouchableOpacity>
              <Text style={styles.iosTitle}>Choose time</Text>
              <TouchableOpacity
                testID={`${testIDPrefix}-done`}
                onPress={confirmIos}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={[styles.iosToolbarBtn, styles.iosToolbarBtnDone]}>Done</Text>
              </TouchableOpacity>
            </View>
            <DateTimePicker
              testID={`${testIDPrefix}-wheel`}
              value={iosDraft}
              mode="time"
              display="spinner"
              is24Hour={false}
              onChange={(_e: any, selected?: Date) => {
                if (selected) setIosDraft(selected);
              }}
              themeVariant="light"
              style={styles.iosWheel}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}


// ============= Web fallback (inline custom picker) =============
function WebInlinePicker({
  value, onChange, testIDPrefix = 'time-picker',
  defaultHour = 8, defaultMinute = 0, defaultAmPm = 'AM',
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
  // ----- Web inline picker -----
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

  // ----- Native field button -----
  fieldButton: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.background,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    minWidth: 180,
    gap: 12,
  },
  fieldButtonText: {
    fontSize: 22,
    fontWeight: '700',
    color: Colors.textPrimary,
    flex: 1,
  },
  fieldButtonHint: {
    fontSize: 12,
    fontWeight: '700',
    color: Colors.textTertiary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },

  // ----- iOS modal -----
  iosBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  iosSheet: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: Colors.surface,
    borderRadius: 16,
    overflow: 'hidden',
    boxShadow: '0px 12px 28px rgba(0,0,0,0.25)' as any,
  },
  iosToolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  iosTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.textPrimary,
  },
  iosToolbarBtn: {
    fontSize: 16,
    fontWeight: '600',
    color: Colors.textSecondary,
  },
  iosToolbarBtnDone: {
    color: Colors.primary,
    fontWeight: '800',
  },
  iosWheel: {
    alignSelf: 'stretch',
    backgroundColor: Colors.surface,
  },
});
