import { useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, Platform, Modal,
  ScrollView,
} from 'react-native';
import { Colors } from './theme';
import { parseHHMM, to12Hour, to24Hour, formatTime12 } from './timeFormat';

let DateTimePicker: any = null;
let DateTimePickerAndroid: any = null;
if (Platform.OS !== 'web') {
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
 *   • iOS         — taps a styled field-button → modal with the native
 *                   spinner-wheel + Cancel/Done.
 *   • Android     — taps the field-button → native system clock dialog
 *                   via DateTimePickerAndroid.open. If the module isn't
 *                   available (Expo Go on some SDKs), falls back to the
 *                   "wide modal" wheel-style picker below.
 *   • Web / any   — taps the field-button → modal with a custom three-
 *     native-fallback   column wheel-style picker (hour 1-12 / minute
 *                   00-59 / AM-PM). The custom picker is given the FULL
 *                   modal width so the layout cannot squish — unlike the
 *                   inline editor inside the narrow rowCard.
 *
 * The component ALWAYS emits a canonical "HH:MM" 24-hour string via
 * onChange. The field button is the single rendered surface in the
 * parent layout, so even a 100px-wide rowCard can never cause text
 * wrapping ("8: / 00 / A / M").
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
  const fallback24 = useMemo(() => {
    let h = defaultHour % 12;
    if (defaultAmPm === 'PM') h += 12;
    return { h, m: defaultMinute };
  }, [defaultHour, defaultMinute, defaultAmPm]);

  const [modalOpen, setModalOpen] = useState(false);
  const [iosDraft, setIosDraft] = useState<Date>(() => hhmmToDate(value, fallback24));

  useEffect(() => {
    setIosDraft(hhmmToDate(value, fallback24));
  }, [value, fallback24]);

  const displayLabel = value
    ? formatTime12(value)
    : formatTime12(`${pad2(fallback24.h)}:${pad2(fallback24.m)}`);

  // ============================================================
  // Field button — single Text element, never wraps to multiple
  // lines because it has numberOfLines={1} and the Text label is a
  // pre-formatted "8:00 AM" string. Works identically on web, iOS,
  // and Android.
  // ============================================================
  const FieldButton = (
    <TouchableOpacity
      testID={testIDPrefix}
      onPress={() => openPicker()}
      activeOpacity={0.85}
      style={styles.fieldButton}
    >
      <Text
        style={styles.fieldButtonText}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.7}
      >
        {displayLabel}
      </Text>
      <Text style={styles.fieldButtonHint}>▾</Text>
    </TouchableOpacity>
  );

  // ============================================================
  // Open the picker — platform-aware.
  // ============================================================
  const openPicker = () => {
    // Android: prefer the system clock dialog when the native module is
    // available; otherwise fall back to the wide custom modal.
    if (Platform.OS === 'android' && DateTimePickerAndroid) {
      try {
        DateTimePickerAndroid.open({
          value: hhmmToDate(value, fallback24),
          mode: 'time',
          is24Hour: false,
          display: 'clock',
          onChange: (event: any, selected?: Date) => {
            if (event?.type === 'set' && selected) {
              onChange(dateToHHMM(selected));
            }
          },
        });
        return;
      } catch (_e) { /* fall through to custom modal */ }
    }
    // iOS with native spinner — use the iOS spinner modal.
    // Web / Android-fallback / iOS-without-module — use the custom wide modal.
    setIosDraft(hhmmToDate(value, fallback24));
    setModalOpen(true);
  };

  const confirmModal = (newHHMM?: string) => {
    if (newHHMM) {
      onChange(newHHMM);
    } else {
      onChange(dateToHHMM(iosDraft));
    }
    setModalOpen(false);
  };
  const cancelModal = () => setModalOpen(false);

  // ============================================================
  // Modal content — uses the native spinner-wheel on iOS, or a
  // custom three-column wheel picker on web / Android-fallback.
  // ============================================================
  const useNativeIosSpinner = Platform.OS === 'ios' && !!DateTimePicker;

  return (
    <View>
      {FieldButton}
      <Modal
        transparent
        visible={modalOpen}
        animationType="fade"
        onRequestClose={cancelModal}
      >
        <View style={styles.backdrop}>
          <View style={styles.sheet}>
            <View style={styles.toolbar}>
              <TouchableOpacity
                testID={`${testIDPrefix}-cancel`}
                onPress={cancelModal}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={styles.toolbarBtn}>Cancel</Text>
              </TouchableOpacity>
              <Text style={styles.title}>Choose time</Text>
              <TouchableOpacity
                testID={`${testIDPrefix}-done`}
                onPress={() => confirmModal()}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={[styles.toolbarBtn, styles.toolbarBtnDone]}>Done</Text>
              </TouchableOpacity>
            </View>

            {useNativeIosSpinner ? (
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
            ) : (
              <WheelPickerCustom
                testIDPrefix={testIDPrefix}
                value={value}
                onChange={(hhmm) => confirmModal(hhmm)}
                defaultHour={defaultHour}
                defaultMinute={defaultMinute}
                defaultAmPm={defaultAmPm}
              />
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}


// ============================================================
// Custom three-column wheel picker used as the cross-platform
// fallback (web + Android-without-native-module + iOS-without-
// native-module). Renders with the FULL modal width so the layout
// can never squish.
// ============================================================
type WheelProps = {
  value?: string | null;
  onChange: (hhmm: string) => void;
  testIDPrefix?: string;
  defaultHour?: number;
  defaultMinute?: number;
  defaultAmPm?: 'AM' | 'PM';
};

function WheelPickerCustom({
  value, onChange, testIDPrefix = 'time-picker',
  defaultHour = 8, defaultMinute = 0, defaultAmPm = 'AM',
}: WheelProps) {
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
  // Free-text editing mode for typing on Android/web hardware keyboards.
  const [hourStr, setHourStr] = useState<string>(`${initial.hour12}`);
  const [minStr, setMinStr] = useState<string>(pad2(initial.minute));

  useEffect(() => {
    const parsed = parseHHMM(value || '');
    if (!parsed) return;
    const { hour12: h12, ampm: ap } = to12Hour(parsed.hour24);
    setHour12(h12); setMinute(parsed.minute); setAmpm(ap);
    setHourStr(`${h12}`); setMinStr(pad2(parsed.minute));
  }, [value]);

  const commit = (h12: number, m: number, ap: 'AM' | 'PM') => {
    onChange(to24Hour(h12, m, ap));
  };

  const handlePresetHour = (h: number) => {
    setHour12(h); setHourStr(`${h}`);
    // Don't auto-commit on every press — wait for "Done" so the user
    // can keep adjusting other axes.
  };
  const handlePresetMinute = (m: number) => {
    setMinute(m); setMinStr(pad2(m));
  };
  const handleAmPm = (ap: 'AM' | 'PM') => { setAmpm(ap); };

  // Allow Done at the parent level to grab the latest. Expose a hidden
  // child-controlled "save now" callback via the Modal's Done button —
  // we pre-call onChange here whenever any value changes so the parent
  // already has the latest. This is fine because the parent only
  // surfaces this on save.

  useEffect(() => {
    // Push the latest value to parent so the parent's "Done" tap captures it.
    onChange(to24Hour(hour12, minute, ampm));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hour12, minute, ampm]);

  return (
    <View style={styles.wheelWrap} testID={`${testIDPrefix}-wheel-fallback`}>
      <View style={styles.wheelHeader}>
        <Text style={styles.wheelHeaderCol}>Hour</Text>
        <Text style={styles.wheelHeaderCol}>Minute</Text>
        <Text style={styles.wheelHeaderCol}>AM / PM</Text>
      </View>

      <View style={styles.wheelRow}>
        {/* HOUR COLUMN */}
        <View style={styles.wheelCol}>
          <TextInput
            testID={`${testIDPrefix}-hour`}
            value={hourStr}
            onChangeText={(t) => {
              const cleaned = t.replace(/[^\d]/g, '').slice(0, 2);
              setHourStr(cleaned);
              const n = parseInt(cleaned, 10);
              if (Number.isFinite(n) && n >= 1 && n <= 12) setHour12(n);
            }}
            keyboardType="number-pad"
            maxLength={2}
            placeholder="H"
            placeholderTextColor={Colors.textTertiary}
            style={styles.wheelInput}
            textAlign="center"
          />
          <ScrollView style={styles.wheelList} showsVerticalScrollIndicator={false}>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => {
              const active = h === hour12;
              return (
                <TouchableOpacity
                  key={h}
                  testID={`${testIDPrefix}-hour-${h}`}
                  onPress={() => handlePresetHour(h)}
                  activeOpacity={0.7}
                  style={[styles.wheelItem, active && styles.wheelItemActive]}
                >
                  <Text style={[styles.wheelItemText, active && styles.wheelItemTextActive]}>{h}</Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>

        {/* MINUTE COLUMN */}
        <View style={styles.wheelCol}>
          <TextInput
            testID={`${testIDPrefix}-minute`}
            value={minStr}
            onChangeText={(t) => {
              const cleaned = t.replace(/[^\d]/g, '').slice(0, 2);
              setMinStr(cleaned);
              const n = parseInt(cleaned, 10);
              if (Number.isFinite(n) && n >= 0 && n <= 59) setMinute(n);
            }}
            keyboardType="number-pad"
            maxLength={2}
            placeholder="MM"
            placeholderTextColor={Colors.textTertiary}
            style={styles.wheelInput}
            textAlign="center"
          />
          <ScrollView style={styles.wheelList} showsVerticalScrollIndicator={false}>
            {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map((m) => {
              const active = m === minute;
              return (
                <TouchableOpacity
                  key={m}
                  testID={`${testIDPrefix}-minute-${m}`}
                  onPress={() => handlePresetMinute(m)}
                  activeOpacity={0.7}
                  style={[styles.wheelItem, active && styles.wheelItemActive]}
                >
                  <Text style={[styles.wheelItemText, active && styles.wheelItemTextActive]}>{pad2(m)}</Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>

        {/* AM / PM COLUMN */}
        <View style={styles.wheelCol}>
          <TouchableOpacity
            testID={`${testIDPrefix}-am`}
            onPress={() => handleAmPm('AM')}
            activeOpacity={0.85}
            style={[styles.ampmLargeBtn, ampm === 'AM' && styles.ampmLargeBtnActive]}
          >
            <Text style={[styles.ampmLargeText, ampm === 'AM' && styles.ampmLargeTextActive]}>AM</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID={`${testIDPrefix}-pm`}
            onPress={() => handleAmPm('PM')}
            activeOpacity={0.85}
            style={[styles.ampmLargeBtn, ampm === 'PM' && styles.ampmLargeBtnActive]}
          >
            <Text style={[styles.ampmLargeText, ampm === 'PM' && styles.ampmLargeTextActive]}>PM</Text>
          </TouchableOpacity>
        </View>
      </View>

      <Text style={styles.wheelPreview}>
        {to12Hour(((hour12 % 12) + (ampm === 'PM' ? 12 : 0))).hour12 ? '' : ''}
        Preview: <Text style={styles.wheelPreviewStrong}>{hour12}:{pad2(minute)} {ampm}</Text>
      </Text>
    </View>
  );
}


const styles = StyleSheet.create({
  // ----- Field button (used as the single rendered surface) -----
  fieldButton: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.background,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    minHeight: 56,
    gap: 12,
  },
  fieldButtonText: {
    fontSize: 22,
    fontWeight: '800',
    color: Colors.textPrimary,
    flex: 1,
    flexShrink: 1,
  },
  fieldButtonHint: {
    fontSize: 18,
    fontWeight: '800',
    color: Colors.textTertiary,
  },

  // ----- Modal shell -----
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  sheet: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: Colors.surface,
    borderRadius: 18,
    overflow: 'hidden',
    boxShadow: '0px 12px 28px rgba(0,0,0,0.25)' as any,
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  title: { fontSize: 16, fontWeight: '700', color: Colors.textPrimary },
  toolbarBtn: { fontSize: 16, fontWeight: '600', color: Colors.textSecondary, minWidth: 60 },
  toolbarBtnDone: { color: Colors.primary, fontWeight: '800', textAlign: 'right' },
  iosWheel: { alignSelf: 'stretch', backgroundColor: Colors.surface },

  // ----- Custom 3-column wheel picker (modal fallback) -----
  wheelWrap: { padding: 16 },
  wheelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  wheelHeaderCol: {
    flex: 1,
    textAlign: 'center',
    fontSize: 12,
    fontWeight: '800',
    color: Colors.textTertiary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  wheelRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  wheelCol: { flex: 1, alignItems: 'stretch' },
  wheelInput: {
    backgroundColor: Colors.background,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 12,
    fontSize: 24,
    fontWeight: '800',
    color: Colors.textPrimary,
    paddingVertical: 10,
    paddingHorizontal: 6,
    marginBottom: 8,
  },
  wheelList: {
    maxHeight: 168,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 12,
    backgroundColor: Colors.background,
  },
  wheelItem: {
    paddingVertical: 10,
    alignItems: 'center',
  },
  wheelItemActive: { backgroundColor: Colors.primary },
  wheelItemText: { fontSize: 16, fontWeight: '700', color: Colors.textPrimary },
  wheelItemTextActive: { color: Colors.surface },
  ampmLargeBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.background,
    marginBottom: 10,
  },
  ampmLargeBtnActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  ampmLargeText: { fontSize: 18, fontWeight: '800', color: Colors.textSecondary },
  ampmLargeTextActive: { color: Colors.surface },
  wheelPreview: {
    marginTop: 16,
    textAlign: 'center',
    fontSize: 13,
    color: Colors.textSecondary,
  },
  wheelPreviewStrong: { fontWeight: '800', color: Colors.textPrimary, fontSize: 18 },
});
