import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Image,
  ActivityIndicator, Alert, Linking, Platform, RefreshControl, TextInput,
} from 'react-native';
import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Icon } from '../../src/Icon';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import { Colors, StatusColor } from '../../src/theme';
import { api, Member, Reminder } from '../../src/api';
import { useAuth } from '../../src/AuthContext';
import { isFallEnabled } from '../../src/fallDetector';
import MemberMap from '../../src/MemberMap';
import { formatTime12, formatRelativeLocal, formatShortDate, getDeviceTimezone } from '../../src/timeFormat';
import { TimePicker12 } from '../../src/TimePicker12';
import { pickContact, isContactsPickerSupported } from '../../src/contactsPicker';

const INTERVAL_OPTIONS = [2, 4, 6, 8, 12] as const;
type CheckinMode = 'fixed' | 'interval' | 'disabled';

export default function MemberDetail() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const [member, setMember] = useState<Member | null>(null);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [history, setHistory] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showCheckinSettings, setShowCheckinSettings] = useState(false);
  const [fallOn, setFallOn] = useState<boolean>(true);

  useEffect(() => {
    isFallEnabled().then(setFallOn).catch(() => {});
  }, []);

  const load = async () => {
    try {
      const [m, r, h] = await Promise.all([
        api.get(`/members/${id}`),
        api.get(`/reminders/member/${id}`),
        api.get(`/history/member/${id}?days=7`).catch(() => ({ data: null })),
      ]);
      setMember(m.data);
      setReminders(r.data);
      setHistory(h.data);
    } catch (_e) {}
  };

  useFocusEffect(useCallback(() => {
    // Silent re-fetch on subsequent focuses so the UI (including the Check In button)
    // doesn't unmount/flash. Only the very first load shows the full-screen spinner.
    load().finally(() => setLoading(false));
  }, [id]));

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const markReminder = async (rid: string, status: 'taken' | 'missed') => {
    try {
      await api.post(`/reminders/${rid}/mark`, { status });
      load();
    } catch (_e) {
      Alert.alert('Failed', 'Could not update reminder.');
    }
  };

  const deleteReminder = (rid: string, title: string) => {
    Alert.alert('Remove?', `Remove "${title}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: async () => {
          await api.delete(`/reminders/${rid}`).catch(() => {});
          load();
        } },
    ]);
  };

  const markRefilled = (rid: string, title: string) => {
    Alert.alert(
      'Mark refilled?',
      `Reset the supply countdown for "${title}"? Use this every time you pick up a new bottle.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Mark refilled',
          onPress: async () => {
            try {
              await api.post(`/reminders/${rid}/mark-refilled`, {});
              load();
            } catch (e: any) {
              Alert.alert('Failed', e?.response?.data?.detail || 'Could not update.');
            }
          },
        },
      ],
    );
  };

  const checkIn = () => {
    // INSTANT: navigate to confirmation screen first so it feels instant (<1s).
    router.push({ pathname: '/check-in', params: { name: member?.name } });
    // Backend work runs in the background.
    (async () => {
      try {
        let lat: number | undefined, lon: number | undefined, loc_name: string | undefined;
        try {
          const { status } = await Location.requestForegroundPermissionsAsync();
          if (status === 'granted') {
            const pos = await Location.getCurrentPositionAsync({
              accuracy: Location.Accuracy.Balanced,
            });
            lat = pos.coords.latitude;
            lon = pos.coords.longitude;
            loc_name = 'Current Location';
          }
        } catch (_e) {}
        await api.post('/checkins', { member_id: id, latitude: lat, longitude: lon, location_name: loc_name });
      } catch (_e) {
        // Silent failure on the network side; the user has already seen the confirmation.
      }
    })();
  };

  const [checkinDraftTime, setCheckinDraftTime] = useState<string>('08:00');

  const saveFixedCheckin = async (hhmm: string) => {
    try {
      const r = await api.put(`/members/${id}/checkin-settings`, {
        daily_checkin_time: hhmm,
        checkin_interval_hours: null,
      });
      setMember(r.data);
      setShowCheckinSettings(false);
    } catch (_e) {
      Alert.alert('Failed', 'Could not update check-in time.');
    }
  };
  const saveIntervalCheckin = async (hours: number) => {
    try {
      const r = await api.put(`/members/${id}/checkin-settings`, {
        daily_checkin_time: null,
        checkin_interval_hours: hours,
      });
      setMember(r.data);
      setShowCheckinSettings(false);
    } catch (_e) {
      Alert.alert('Failed', 'Could not update check-in interval.');
    }
  };
  const disableCheckin = async () => {
    try {
      const r = await api.put(`/members/${id}/checkin-settings`, {
        daily_checkin_time: null,
        checkin_interval_hours: null,
      });
      setMember(r.data);
      setShowCheckinSettings(false);
    } catch (_e) {
      Alert.alert('Failed', 'Could not disable check-ins.');
    }
  };

  // ----- Emergency contact (SMS) editor state -----
  const [ecEditing, setEcEditing] = useState(false);
  const [ecValue, setEcValue] = useState('');
  const [ecName, setEcName] = useState('');
  const [ecMode, setEcMode] = useState<'choose' | 'manual'>('choose');
  const startEcEdit = () => {
    setEcValue(member?.emergency_contact_phone || '');
    setEcName(member?.emergency_contact_name || '');
    // If we already have a value, jump straight into manual edit mode.
    setEcMode(member?.emergency_contact_phone ? 'manual' : 'choose');
    setEcEditing(true);
  };
  const saveEc = async (overridePhone?: string, overrideName?: string | null) => {
    const phone = (overridePhone !== undefined ? overridePhone : ecValue).trim();
    const name = (overrideName !== undefined ? overrideName : ecName).trim();
    try {
      const r = await api.put(`/members/${id}`, {
        emergency_contact_phone: phone || null,
        emergency_contact_name: name || null,
      });
      setMember(r.data);
      setEcEditing(false);
    } catch (e: any) {
      Alert.alert(
        'Invalid phone',
        e?.response?.data?.detail || 'Please enter a valid phone number (e.g. +1 555 123 4567).',
      );
    }
  };
  const pickFromContacts = async () => {
    const picked = await pickContact();
    if (!picked) return;
    setEcValue(picked.phone);
    setEcName(picked.name);
    setEcMode('manual'); // jump into the manual editor showing pre-filled values
    // Save immediately — user can still tweak before/after via "Edit".
    await saveEc(picked.phone, picked.name);
  };

  const onDelete = () => {
    Alert.alert('Remove member?', `Are you sure you want to remove ${member?.name}?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: async () => {
          await api.delete(`/members/${id}`).catch(() => {});
          router.back();
        } },
    ]);
  };

  if (loading || !member) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator color={Colors.primary} size="large" />
        </View>
      </SafeAreaView>
    );
  }

  const initials = member.name.split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase();
  const hasCoords = member.latitude != null && member.longitude != null;
  const coordsLabel = hasCoords
    ? `${member.latitude!.toFixed(4)}°, ${member.longitude!.toFixed(4)}°`
    : 'Not available yet';
  const dot = member.status === 'healthy' ? '🟢' : member.status === 'warning' ? '🟡' : '🔴';

  const meds = reminders.filter(r => r.category === 'medication');
  const routines = reminders.filter(r => r.category === 'routine');
  const medsTaken = meds.filter(r => r.status === 'taken').length;
  const routinesDone = routines.filter(r => r.status === 'taken').length;

  const openDirections = () => {
    const label = encodeURIComponent(member.location_name || member.name);
    let url: string;
    if (hasCoords) {
      const latlon = `${member.latitude},${member.longitude}`;
      url = Platform.select({
        ios: `maps:0,0?q=${label}@${latlon}`,
        android: `geo:0,0?q=${latlon}(${label})`,
        default: `https://www.google.com/maps/search/?api=1&query=${latlon}`,
      })!;
    } else {
      url = `https://www.google.com/maps/search/?api=1&query=${label}`;
    }
    Linking.openURL(url).catch(() => Alert.alert('Unable to open maps'));
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity testID="member-back" onPress={() => router.back()} style={styles.iconBtn}>
          <Icon name="arrow-back" size={22} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Member</Text>
        <TouchableOpacity testID="member-call" onPress={() => Linking.openURL(`tel:${member.phone}`)} style={styles.iconBtn}>
          <Text style={{ fontSize: 18 }}>📞</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: 120 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
      >
        <View style={styles.profile}>
          <View style={styles.avatarWrap}>
            {member.avatar_url ? (
              <Image source={{ uri: member.avatar_url }} style={styles.avatar} />
            ) : (
              <View style={[styles.avatar, styles.avatarFallback]}>
                <Text style={styles.avatarText}>{initials}</Text>
              </View>
            )}
            <View style={[styles.statusDot, { backgroundColor: StatusColor(member.status) }]} />
          </View>
          <Text style={styles.name}>{member.name} {dot}</Text>
          <Text style={styles.meta}>{member.age} years · {member.gender} · {member.role === 'senior' ? '👴 Senior' : '👨‍👩‍👧 Family'}</Text>
          <Text style={styles.phoneText}>📞 {member.phone}</Text>
        </View>

        {/* Location Card */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Location</Text>
          <View style={styles.locationCard}>
            <View style={styles.locRow}>
              <View style={styles.locPinBubble}><Text style={styles.locPinEmoji}>📍</Text></View>
              <View style={{ flex: 1, marginLeft: 14 }}>
                <Text style={styles.locName}>{member.location_name || 'Unknown location'}</Text>
                <Text style={styles.locSub}>Last seen 🕐 recently</Text>
              </View>
            </View>
            <View style={{ marginTop: 12 }}>
              <MemberMap
                latitude={member.latitude}
                longitude={member.longitude}
                memberName={member.name}
                locationName={member.location_name || undefined}
                height={220}
              />
            </View>
            <TouchableOpacity testID="member-get-directions" onPress={openDirections} activeOpacity={0.85} style={styles.directionsBtn}>
              <Text style={styles.directionsEmoji}>🗺</Text>
              <Text style={styles.directionsText}>Get Directions</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Active Safety Features */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Active Safety</Text>
          <View
            testID="member-fall-badge"
            style={[styles.featureCard, !fallOn && styles.featureCardOff]}
          >
            <View style={[styles.featureIcon, !fallOn && styles.featureIconOff]}>
              <Text style={styles.featureIconText}>🚨</Text>
            </View>
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={styles.featureTitle}>Fall Detection</Text>
              <Text style={styles.featureBody}>
                {fallOn
                  ? 'Active — accelerometer is watching for sudden falls. 30 s grace period before automatic SOS.'
                  : 'Off — turn on in Settings to detect falls automatically.'}
              </Text>
            </View>
            <View style={[styles.featurePill, fallOn ? styles.featurePillOn : styles.featurePillOff]}>
              <Text style={[styles.featurePillText, !fallOn && { color: Colors.textTertiary }]}>
                {fallOn ? 'ACTIVE' : 'OFF'}
              </Text>
            </View>
          </View>
        </View>

        {/* Emergency Contact (SMS) */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Emergency Contact (SMS)</Text>
            <TouchableOpacity
              testID="ec-toggle"
              onPress={() => (ecEditing ? setEcEditing(false) : startEcEdit())}
            >
              <Text style={styles.linkText}>{ecEditing ? 'Cancel' : member?.emergency_contact_phone ? 'Edit' : 'Add'}</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.settingCard}>
            {ecEditing ? (
              ecMode === 'choose' ? (
                <View testID="ec-choose">
                  <Text style={styles.settingLabel}>How would you like to add the contact?</Text>
                  <TouchableOpacity
                    testID="ec-pick-from-contacts"
                    onPress={pickFromContacts}
                    activeOpacity={0.85}
                    style={[styles.ecOptionBtn, !isContactsPickerSupported() && styles.ecOptionBtnDisabled]}
                    disabled={!isContactsPickerSupported()}
                  >
                    <Text style={styles.ecOptionEmoji}>📇</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.ecOptionTitle}>Pick from Contacts</Text>
                      <Text style={styles.ecOptionSub}>
                        {isContactsPickerSupported()
                          ? 'Select someone from your phone — auto-fills name & number.'
                          : 'Not available on this device. Enter manually below.'}
                      </Text>
                    </View>
                  </TouchableOpacity>
                  <TouchableOpacity
                    testID="ec-enter-manually"
                    onPress={() => setEcMode('manual')}
                    activeOpacity={0.85}
                    style={styles.ecOptionBtn}
                  >
                    <Text style={styles.ecOptionEmoji}>✏️</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.ecOptionTitle}>Enter manually</Text>
                      <Text style={styles.ecOptionSub}>Type a name and phone number yourself.</Text>
                    </View>
                  </TouchableOpacity>
                </View>
              ) : (
                <>
                  <Text style={styles.settingLabel}>Contact name (optional)</Text>
                  <TextInput
                    testID="ec-name-input"
                    value={ecName}
                    onChangeText={setEcName}
                    placeholder="Jane Smith"
                    placeholderTextColor={Colors.textTertiary}
                    style={styles.ecInput}
                  />
                  <Text style={[styles.settingLabel, { marginTop: 12 }]}>Phone (we'll auto-format to E.164)</Text>
                  <TextInput
                    testID="ec-input"
                    value={ecValue}
                    onChangeText={setEcValue}
                    placeholder="+1 555 123 4567"
                    keyboardType="phone-pad"
                    placeholderTextColor={Colors.textTertiary}
                    style={styles.ecInput}
                  />
                  <TouchableOpacity
                    testID="ec-save"
                    style={styles.ecSaveBtn}
                    onPress={() => saveEc()}
                    activeOpacity={0.85}
                  >
                    <Text style={styles.ecSaveText}>Save Emergency Contact</Text>
                  </TouchableOpacity>
                </>
              )
            ) : member?.emergency_contact_phone ? (
              <View testID="ec-display">
                {!!member.emergency_contact_name && (
                  <Text style={styles.ecName}>{member.emergency_contact_name}</Text>
                )}
                <Text style={styles.ecValue}>{member.emergency_contact_phone}</Text>
                <Text style={styles.ecHelp}>
                  📱 Receives an SMS the moment {member?.name} triggers SOS or fall detection.
                </Text>
              </View>
            ) : (
              <View testID="ec-empty">
                <Text style={styles.ecEmpty}>No emergency contact set</Text>
                <Text style={styles.ecHelp}>
                  Add a phone number so a designated person gets an SMS alert during SOS or fall detection.
                </Text>
              </View>
            )}
          </View>
        </View>

        {/* Check-in Settings */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Daily Check-in</Text>
            <TouchableOpacity testID="checkin-settings-toggle" onPress={() => setShowCheckinSettings(v => !v)}>
              <Text style={styles.linkText}>{showCheckinSettings ? 'Done' : 'Edit'}</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.settingCard}>
            <Text style={styles.settingLabel}>Expected check-in ({getDeviceTimezone()})</Text>
            <Text style={styles.settingValue} testID="checkin-display">
              {member.checkin_interval_hours
                ? `🔁 Every ${member.checkin_interval_hours} hours`
                : member.daily_checkin_time
                  ? `🕐 ${formatTime12(member.daily_checkin_time)} (daily)`
                  : '— Not set'}
            </Text>
            {showCheckinSettings && (
              <View style={{ marginTop: 14 }}>
                <Text style={styles.checkinModeLabel}>Custom daily time</Text>
                <View style={styles.timeRow}>
                  <TimePicker12
                    testIDPrefix="checkin-time-picker"
                    value={member.daily_checkin_time || checkinDraftTime}
                    onChange={setCheckinDraftTime}
                  />
                  <TouchableOpacity
                    testID="checkin-save-fixed"
                    onPress={() => saveFixedCheckin(checkinDraftTime || member.daily_checkin_time || '08:00')}
                    activeOpacity={0.85}
                    style={styles.savePill}
                  >
                    <Text style={styles.savePillText}>Save time</Text>
                  </TouchableOpacity>
                </View>

                <Text style={[styles.checkinModeLabel, { marginTop: 18 }]}>Or recurring every…</Text>
                <View style={styles.intervalRow}>
                  {INTERVAL_OPTIONS.map(h => {
                    const active = member.checkin_interval_hours === h;
                    return (
                      <TouchableOpacity
                        key={h}
                        testID={`checkin-interval-${h}`}
                        onPress={() => saveIntervalCheckin(h)}
                        activeOpacity={0.85}
                        style={[styles.intervalPill, active && styles.intervalPillActive]}
                      >
                        <Text style={[styles.intervalPillText, active && styles.intervalPillTextActive]}>
                          {h}h
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                <TouchableOpacity
                  testID="checkin-time-clear"
                  onPress={disableCheckin}
                  activeOpacity={0.85}
                  style={styles.disablePill}
                >
                  <Text style={styles.disablePillText}>Disable check-ins</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        </View>

        {/* Medications */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>💊 Medications ({medsTaken}/{meds.length})</Text>
            <TouchableOpacity
              testID="add-medication-btn"
              onPress={() => router.push(`/add-medication/${id}`)}
              style={styles.addBtnSmall}
            >
              <Text style={styles.addBtnSmallText}>➕ Add</Text>
            </TouchableOpacity>
          </View>
          {meds.length === 0 ? (
            <Text style={styles.emptyText}>No medications yet. Tap Add to create one.</Text>
          ) : meds.map(r => (
            <ReminderRow key={r.id} reminder={r} onMark={markReminder} onDelete={deleteReminder} onEdit={(rid) => router.push(`/edit-medication/${rid}`)} onMarkRefilled={markRefilled} />
          ))}

          {history && history.totals && history.totals.logged > 0 && (
            <ComplianceChart history={history} />
          )}
        </View>

        {/* Daily Routine */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>🌿 Daily Routine ({routinesDone}/{routines.length})</Text>
            <TouchableOpacity
              testID="add-routine-btn"
              onPress={() => router.push(`/add-routine/${id}`)}
              style={styles.addBtnSmall}
            >
              <Text style={styles.addBtnSmallText}>➕ Add</Text>
            </TouchableOpacity>
          </View>
          {routines.length === 0 ? (
            <Text style={styles.emptyText}>No routine items yet.</Text>
          ) : routines.map(r => (
            <ReminderRow key={r.id} reminder={r} onMark={markReminder} onDelete={deleteReminder} onEdit={(rid) => router.push(`/edit-medication/${rid}`)} onMarkRefilled={markRefilled} />
          ))}
        </View>

        <TouchableOpacity testID="member-delete" onPress={onDelete} style={styles.deleteBtn}>
          <Text style={{ fontSize: 14 }}>🗑</Text>
          <Text style={styles.deleteText}>Remove member</Text>
        </TouchableOpacity>
      </ScrollView>

      <TouchableOpacity testID="member-checkin" onPress={checkIn} activeOpacity={0.85} style={styles.checkinBtn}>
        <Text style={styles.checkinEmoji}>✅</Text>
        <Text style={styles.checkinText}>Check in {member.name}</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

function ReminderRow({ reminder, onMark, onDelete, onEdit, onMarkRefilled }: {
  reminder: Reminder;
  onMark: (id: string, s: 'taken' | 'missed') => void;
  onDelete: (id: string, title: string) => void;
  onEdit: (id: string) => void;
  onMarkRefilled: (id: string, title: string) => void;
}) {
  const isTaken = reminder.status === 'taken';
  const isMissed = reminder.status === 'missed';
  const timeStr = (reminder.times && reminder.times.length > 0
    ? reminder.times.map(t => t.label ? `${t.label} ${formatTime12(t.time)}` : formatTime12(t.time))
    : [formatTime12(reminder.time)]).filter(Boolean).join(' · ');

  // ---- Refill state ----
  let refillBadge: { text: string; tone: 'low' | 'out' | 'soon' } | null = null;
  if (reminder.run_out_at && reminder.refill_reminder_days) {
    const runOutMs = new Date(reminder.run_out_at).getTime();
    const daysLeft = Math.round((runOutMs - Date.now()) / 86400000);
    if (daysLeft <= 0) {
      refillBadge = { text: '🟥 Out of supply — refill ASAP', tone: 'out' };
    } else if (daysLeft <= reminder.refill_reminder_days) {
      refillBadge = {
        text: `🟧 Refill in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
        tone: daysLeft <= 3 ? 'low' : 'soon',
      };
    }
  }

  return (
    <View testID={`reminder-${reminder.id}`} style={styles.reminderCard}>
      <View style={{ flex: 1 }}>
        <View style={styles.reminderTitleRow}>
          <Text style={styles.reminderEmoji}>{reminder.category === 'medication' ? '💊' : '🌿'}</Text>
          <Text style={styles.reminderTitle}>{reminder.title}</Text>
        </View>
        {reminder.dosage ? <Text style={styles.reminderSub}>{reminder.dosage}</Text> : null}
        <Text style={styles.reminderTime}>🕐 {timeStr}</Text>
        {isMissed && <Text style={styles.missedTag}>⚠ Missed — family alerted</Text>}
        {refillBadge && (
          <View
            testID={`refill-badge-${reminder.id}`}
            style={[
              styles.refillBadge,
              refillBadge.tone === 'out' && styles.refillBadgeOut,
              refillBadge.tone === 'low' && styles.refillBadgeLow,
            ]}
          >
            <Text
              style={[
                styles.refillBadgeText,
                refillBadge.tone === 'out' && { color: Colors.surface },
                refillBadge.tone === 'low' && { color: Colors.surface },
              ]}
            >
              {refillBadge.text}
            </Text>
            <TouchableOpacity
              testID={`mark-refilled-${reminder.id}`}
              onPress={() => onMarkRefilled(reminder.id, reminder.title)}
              activeOpacity={0.85}
              style={styles.refillCta}
            >
              <Text style={styles.refillCtaText}>Mark refilled</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
      <View style={styles.reminderActions}>
        <TouchableOpacity
          testID={`mark-taken-${reminder.id}`}
          onPress={() => onMark(reminder.id, 'taken')}
          style={[styles.markBtn, isTaken && styles.markBtnTakenActive]}
        >
          <Text style={[styles.markBtnText, isTaken && { color: Colors.surface }]}>✅</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID={`mark-missed-${reminder.id}`}
          onPress={() => onMark(reminder.id, 'missed')}
          style={[styles.markBtn, isMissed && styles.markBtnMissedActive]}
        >
          <Text style={[styles.markBtnText, isMissed && { color: Colors.surface }]}>✕</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID={`edit-reminder-${reminder.id}`}
          onPress={() => onEdit(reminder.id)}
          style={styles.editBtnSmall}
        >
          <Text style={{ fontSize: 14, color: Colors.primary }}>✏️</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID={`delete-reminder-${reminder.id}`}
          onPress={() => onDelete(reminder.id, reminder.title)}
          style={styles.deleteBtnSmall}
        >
          <Text style={{ fontSize: 14, color: Colors.textTertiary }}>🗑</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 8 },
  iconBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border },
  headerTitle: { fontSize: 17, fontWeight: '700', color: Colors.textPrimary },
  profile: { alignItems: 'center', paddingHorizontal: 24, paddingTop: 8, paddingBottom: 16 },
  avatarWrap: { position: 'relative' },
  avatar: { width: 110, height: 110, borderRadius: 55 },
  avatarFallback: { backgroundColor: Colors.tertiary, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 32, color: Colors.primary, fontWeight: '800' },
  statusDot: { position: 'absolute', right: 6, bottom: 6, width: 22, height: 22, borderRadius: 11, borderWidth: 3, borderColor: Colors.background },
  name: { fontSize: 26, fontWeight: '800', color: Colors.textPrimary, marginTop: 12 },
  meta: { fontSize: 14, color: Colors.textSecondary, marginTop: 4 },
  phoneText: { fontSize: 14, color: Colors.textTertiary, marginTop: 4 },
  section: { marginHorizontal: 24, marginTop: 18 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  sectionTitle: { fontSize: 17, fontWeight: '700', color: Colors.textPrimary },
  linkText: { color: Colors.primary, fontWeight: '700', fontSize: 14 },
  addBtnSmall: { backgroundColor: Colors.tertiary, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999 },
  addBtnSmallText: { color: Colors.primary, fontWeight: '700', fontSize: 13 },
  // Location card
  locationCard: { backgroundColor: Colors.surface, borderRadius: 18, padding: 16, borderWidth: 1, borderColor: Colors.border },
  locRow: { flexDirection: 'row', alignItems: 'center' },
  locPinBubble: { width: 48, height: 48, borderRadius: 24, backgroundColor: Colors.tertiary, alignItems: 'center', justifyContent: 'center' },
  locPinEmoji: { fontSize: 22 },
  locName: { fontSize: 16, fontWeight: '700', color: Colors.textPrimary },
  locSub: { fontSize: 13, color: Colors.textTertiary, marginTop: 2 },
  locDivider: { height: 1, backgroundColor: Colors.border, marginVertical: 12 },
  locMetaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4 },
  locMetaLabel: { fontSize: 12, fontWeight: '700', color: Colors.textTertiary, textTransform: 'uppercase', letterSpacing: 0.5 },
  locMetaValue: { fontSize: 13, color: Colors.textPrimary, fontWeight: '600' },
  directionsBtn: { marginTop: 12, height: 48, borderRadius: 14, backgroundColor: Colors.primary, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  directionsEmoji: { fontSize: 16 },
  directionsText: { color: Colors.surface, fontSize: 15, fontWeight: '700' },
  // Settings card
  settingCard: { backgroundColor: Colors.surface, borderRadius: 16, padding: 14, borderWidth: 1, borderColor: Colors.border },
  settingLabel: { fontSize: 12, fontWeight: '700', color: Colors.textTertiary, textTransform: 'uppercase', letterSpacing: 0.5 },
  settingValue: { fontSize: 16, color: Colors.textPrimary, fontWeight: '700', marginTop: 4 },
  timeRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginTop: 8 },
  timePill: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border },
  timePillActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  timePillText: { fontWeight: '700', color: Colors.textSecondary, fontSize: 13 },
  timePillTextActive: { color: Colors.surface },
  checkinModeLabel: { fontSize: 12, fontWeight: '700', color: Colors.textTertiary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
  savePill: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, backgroundColor: Colors.primary },
  savePillText: { color: Colors.surface, fontWeight: '700', fontSize: 13 },
  intervalRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  intervalPill: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 999, backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border, minWidth: 56, alignItems: 'center' },
  intervalPillActive: { backgroundColor: Colors.secondary, borderColor: Colors.secondary },
  intervalPillText: { fontWeight: '800', color: Colors.textSecondary, fontSize: 14 },
  intervalPillTextActive: { color: Colors.surface },
  disablePill: { marginTop: 16, paddingVertical: 12, borderRadius: 12, backgroundColor: Colors.errorBg, alignItems: 'center' },
  disablePillText: { color: Colors.error, fontWeight: '700', fontSize: 13 },
  // Reminder row
  reminderCard: { flexDirection: 'row', backgroundColor: Colors.surface, padding: 12, borderRadius: 14, marginTop: 8, borderWidth: 1, borderColor: Colors.border, alignItems: 'center' },
  reminderTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  reminderEmoji: { fontSize: 16 },
  reminderTitle: { fontSize: 15, fontWeight: '700', color: Colors.textPrimary },
  reminderSub: { fontSize: 13, color: Colors.textSecondary, marginTop: 2, marginLeft: 24 },
  reminderTime: { fontSize: 12, color: Colors.textTertiary, marginTop: 2, marginLeft: 24 },
  missedTag: { fontSize: 12, color: Colors.warning, fontWeight: '700', marginTop: 4, marginLeft: 24 },
  refillBadge: {
    marginTop: 8,
    flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap',
    backgroundColor: '#FFF4D6',
    borderRadius: 10,
    paddingHorizontal: 10, paddingVertical: 8,
    gap: 8,
  },
  refillBadgeLow: { backgroundColor: '#D97706' },
  refillBadgeOut: { backgroundColor: Colors.error },
  refillBadgeText: {
    fontSize: 12, fontWeight: '800', color: Colors.textPrimary, flex: 1, minWidth: 130,
  },
  refillCta: {
    backgroundColor: Colors.surface,
    borderRadius: 999,
    paddingVertical: 6, paddingHorizontal: 12,
  },
  refillCtaText: { color: Colors.primary, fontWeight: '800', fontSize: 12 },
  reminderActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  markBtn: { width: 36, height: 36, borderRadius: 12, backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border, alignItems: 'center', justifyContent: 'center' },
  markBtnTakenActive: { backgroundColor: Colors.success, borderColor: Colors.success },
  markBtnMissedActive: { backgroundColor: Colors.error, borderColor: Colors.error },
  markBtnText: { fontSize: 14, color: Colors.textSecondary, fontWeight: '700' },
  editBtnSmall: { width: 28, height: 36, alignItems: 'center', justifyContent: 'center' },
  deleteBtnSmall: { width: 28, height: 36, alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: Colors.textTertiary, fontSize: 13, fontStyle: 'italic', paddingVertical: 8 },
  deleteBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 28, paddingVertical: 12 },
  deleteText: { color: Colors.error, fontWeight: '700' },
  checkinBtn: {
    position: 'absolute', bottom: 24, left: 24, right: 24,
    height: 60, backgroundColor: Colors.primary, borderRadius: 18,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    boxShadow: '0px 8px 14px rgba(27,94,53,0.3)', elevation: 8,
  },
  checkinEmoji: { fontSize: 22 },
  checkinText: { color: Colors.surface, fontSize: 17, fontWeight: '700' },

  // Compliance chart
  chartCard: { backgroundColor: Colors.surface, borderRadius: 16, padding: 14, marginTop: 14, borderWidth: 1, borderColor: Colors.border },
  chartHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 12 },
  chartTitle: { fontSize: 14, fontWeight: '700', color: Colors.textPrimary },
  chartSub: { fontSize: 12, color: Colors.textTertiary, marginTop: 2 },
  complianceBig: { fontSize: 28, fontWeight: '800', color: Colors.primary },
  complianceLabel: { fontSize: 10, color: Colors.textTertiary, textTransform: 'uppercase', letterSpacing: 0.5, textAlign: 'right' },
  barsRow: { flexDirection: 'row', alignItems: 'flex-end', height: 110, gap: 6, marginBottom: 6 },
  barCol: { flex: 1, alignItems: 'center', justifyContent: 'flex-end' },
  bar: { width: '100%', borderRadius: 6, minHeight: 4 },
  barLabel: { fontSize: 10, color: Colors.textTertiary, marginTop: 4 },
  barCount: { fontSize: 10, color: Colors.textSecondary, fontWeight: '700' },
  legendRow: { flexDirection: 'row', gap: 14, justifyContent: 'center', marginTop: 6 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendText: { fontSize: 11, color: Colors.textSecondary, fontWeight: '600' },
  featureCard: {
    flexDirection: 'row', alignItems: 'center',
    padding: 14, borderRadius: 14,
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.tertiary,
    boxShadow: '0px 4px 12px rgba(27,94,53,0.08)' as any,
  },
  featureCardOff: { borderColor: Colors.border, opacity: 0.85 },
  featureIcon: {
    width: 44, height: 44, borderRadius: 22, backgroundColor: Colors.tertiary,
    alignItems: 'center', justifyContent: 'center',
  },
  featureIconOff: { backgroundColor: Colors.background },
  featureIconText: { fontSize: 22 },
  featureTitle: { fontSize: 14, fontWeight: '800', color: Colors.textPrimary },
  ecInput: {
    backgroundColor: Colors.background, borderRadius: 10, paddingHorizontal: 14,
    paddingVertical: 12, fontSize: 16, borderWidth: 1, borderColor: Colors.border,
    marginTop: 4, color: Colors.textPrimary,
  },
  ecSaveBtn: {
    marginTop: 12, height: 44, borderRadius: 10, backgroundColor: Colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  ecSaveText: { color: Colors.surface, fontSize: 14, fontWeight: '800' },
  ecValue: { fontSize: 18, fontWeight: '800', color: Colors.textPrimary },
  ecName: { fontSize: 13, fontWeight: '700', color: Colors.textSecondary, marginBottom: 2 },
  ecOptionBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 12, paddingHorizontal: 14,
    backgroundColor: Colors.background,
    borderRadius: 14,
    borderWidth: 1, borderColor: Colors.border,
    marginTop: 10,
  },
  ecOptionBtnDisabled: { opacity: 0.6 },
  ecOptionEmoji: { fontSize: 22 },
  ecOptionTitle: { fontSize: 15, fontWeight: '800', color: Colors.textPrimary },
  ecOptionSub: { fontSize: 12, color: Colors.textSecondary, marginTop: 2, lineHeight: 16 },
  ecEmpty: { fontSize: 14, color: Colors.textTertiary, fontStyle: 'italic' },
  ecHelp: { fontSize: 12, color: Colors.textSecondary, marginTop: 6, lineHeight: 17 },
  featureBody: { fontSize: 12, color: Colors.textSecondary, marginTop: 2, lineHeight: 17 },
  featurePill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10, marginLeft: 8 },
  featurePillOn: { backgroundColor: Colors.primary },
  featurePillOff: { backgroundColor: Colors.border },
  featurePillText: { fontSize: 10, fontWeight: '800', color: Colors.surface, letterSpacing: 0.6 },
});

function ComplianceChart({ history }: { history: any }) {
  const series: { date: string; taken: number; missed: number; total: number }[] = history.series || [];
  const maxTotal = Math.max(1, ...series.map(d => d.total || 0));
  const compliance = history.compliance_percent ?? 0;
  const tz = history.timezone || 'UTC';
  const dayLabel = (iso: string) => {
    try {
      const d = new Date(iso + 'T00:00:00');
      return d.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 3);
    } catch { return iso.slice(5); }
  };
  return (
    <View testID="compliance-chart" style={styles.chartCard}>
      <View style={styles.chartHeader}>
        <View>
          <Text style={styles.chartTitle}>📊 Weekly compliance</Text>
          <Text style={styles.chartSub}>
            {history.totals.taken}/{history.totals.logged} taken · {tz}
          </Text>
        </View>
        <View>
          <Text style={styles.complianceBig}>{compliance}%</Text>
          <Text style={styles.complianceLabel}>last 7 days</Text>
        </View>
      </View>
      <View style={styles.barsRow}>
        {series.map(d => {
          const takenH = (d.taken / maxTotal) * 80;
          const missedH = (d.missed / maxTotal) * 80;
          return (
            <View key={d.date} style={styles.barCol}>
              {d.missed > 0 && (
                <View style={[styles.bar, { height: Math.max(4, missedH), backgroundColor: Colors.warning, marginBottom: d.taken > 0 ? 2 : 0 }]} />
              )}
              {d.taken > 0 && (
                <View style={[styles.bar, { height: Math.max(4, takenH), backgroundColor: Colors.primary }]} />
              )}
              {d.total === 0 && (
                <View style={[styles.bar, { height: 4, backgroundColor: Colors.border }]} />
              )}
              <Text style={styles.barCount}>{d.total > 0 ? `${d.taken}/${d.total}` : '–'}</Text>
              <Text style={styles.barLabel}>{dayLabel(d.date)}</Text>
            </View>
          );
        })}
      </View>
      <View style={styles.legendRow}>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: Colors.primary }]} />
          <Text style={styles.legendText}>Taken</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: Colors.warning }]} />
          <Text style={styles.legendText}>Missed</Text>
        </View>
      </View>
    </View>
  );
}
