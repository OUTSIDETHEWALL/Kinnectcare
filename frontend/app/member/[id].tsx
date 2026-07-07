import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Image,
  ActivityIndicator, Alert, Linking, Platform, RefreshControl, TextInput,
  AppState,
} from 'react-native';
import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Icon } from '../../src/Icon';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { logScreenRender } from '../../src/screenRenderLog';
import { Colors, StatusColor } from '../../src/theme';
import { api, Member, Reminder } from '../../src/api';
import { useAuth } from '../../src/AuthContext';
import MemberMap from '../../src/MemberMap';
import { TrackingStatusPill } from '../../src/tracking/TrackingStatusPill';
import { formatTime12, formatRelativeLocal, formatShortDate, getDeviceTimezone, formatTimeAgo } from '../../src/timeFormat';
import { TimePicker12 } from '../../src/TimePicker12';
import { pickContact, isContactsPickerSupported } from '../../src/contactsPicker';
import {
  requestRefresh as requestMemberRefresh,
  clearIfNewer as clearRefreshIfNewer,
  subscribeRefreshing,
  STALE_THRESHOLD_MS,
} from '../../src/locationRefreshState';
import * as memberStore from '../../src/store/memberStore';

const INTERVAL_OPTIONS = [2, 4, 6, 8, 12] as const;
type CheckinMode = 'fixed' | 'interval' | 'disabled';

export default function MemberDetail() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  // Build 47 — Member detail no longer owns a local `member` state
  // object.  It reads from the canonical store via useMember(id) so
  // coordinates + last_seen + location_name + accuracy can never
  // diverge from what the Dashboard renders.
  const member = memberStore.useMember(id) ?? null;
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [history, setHistory] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showCheckinSettings, setShowCheckinSettings] = useState(false);
  // v1.3.2 — live refresh indicator wired to locationRefreshState.
  // Subscribes when `id` is set and unsubscribes on unmount.  The
  // 20-second forceTick keeps the "X min ago" timestamp accurate
  // without spamming the network.
  const [locationRefreshing, setLocationRefreshing] = useState(false);
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!id) return;
    return subscribeRefreshing(id, setLocationRefreshing);
  }, [id]);
  // Build 47 — the old "subscribeMember + setMember merge" useEffect
  // has been DELETED.  `useMember(id)` is itself a live subscription
  // to the canonical store, so any fresh upload arriving from
  // memberStore.requestRefresh()/fetchAll()/fetchOne() rebinds this
  // component automatically — and it sees the exact same record as
  // the Dashboard at the exact same moment (atomic upsert).
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 20_000);
    return () => clearInterval(t);
  }, []);

  const onManualRefresh = useCallback(() => {
    if (!id) return;
    const seenMs = member?.last_seen ? new Date(member.last_seen).getTime() : null;
    requestMemberRefresh(id, seenMs);
    // Also force-refetch /members/{id} immediately so the UI
    // re-syncs once the silent-push roundtrip completes.
    load().catch(() => {});
  }, [id, member?.last_seen]);

  const load = async () => {
    try {
      // Build 47 — `/members/{id}` fetch routes through the canonical
      // store.  The store atomically upserts the returned record so
      // both this screen AND the Dashboard repaint with the same
      // {coords, last_seen, location_name, accuracy} tuple in lockstep.
      const [m, r, h] = await Promise.all([
        memberStore.fetchOne(id as string),
        api.get(`/reminders/member/${id}`),
        api.get(`/history/member/${id}?days=7`).catch(() => ({ data: null })),
      ]);
      // v1.2.8 instrumentation: log what the API returned BEFORE
      // any downstream consumer sees it.  This is now a proof-of-
      // canonical-record marker rather than a proof-of-setState marker.
      try {
        const md: any = m || {};
        await logScreenRender({
          src: 'member-fetch',
          memberId: md.id,
          lat: md.latitude,
          lon: md.longitude,
          lastSeen: md.last_seen ?? null,
          locationName: md.location_name ?? null,
        });
      } catch (_e) {}
      setReminders(r.data);
      setHistory(h.data);

      // v1.3.2 — pull-on-stale (60 s freshness threshold).  If this
      // member's last_seen is older than 60 s, ask the backend to
      // silently ping their device for a fresh GPS upload.  The
      // refresh marker drives the "Refreshing location…" indicator
      // on this screen via the locationRefreshState subscription
      // hook below.
      try {
        const md: any = m || {};
        if (md.id) {
          const seenMs = md.last_seen ? new Date(md.last_seen).getTime() : 0;
          if (seenMs) clearRefreshIfNewer(md.id, seenMs);
          const skipSelf = user?.id && md?.user_id === user.id;
          if (!skipSelf && (!seenMs || (Date.now() - seenMs) >= STALE_THRESHOLD_MS)) {
            requestMemberRefresh(md.id, seenMs || null);
          }
        }
      } catch (_e) {}
    } catch (_e) {}
  };

  useFocusEffect(useCallback(() => {
    // Silent re-fetch on subsequent focuses so the UI (including the Check In button)
    // doesn't unmount/flash. Only the very first load shows the full-screen spinner.
    load().finally(() => setLoading(false));

    // v1.2.7 — same freshness pattern as the Dashboard tab.  Until
    // this OTA the Member detail screen only reloaded on focus.  If
    // Charles opened Joyce's detail and stayed there for an hour
    // while she drove, MemberMap would render her cold-start
    // coordinates the whole time — no polling, no AppState refetch.
    // Three triggers, all gated to this screen being focused so we
    // never refetch in the background:
    //   1. 60 s poll while visible
    //   2. AppState 'active' transition
    //   3. Any notification arrival (member check-in, SOS, etc.)
    const pollId = setInterval(() => { load().catch(() => {}); }, 60_000);
    const appStateSub = AppState.addEventListener('change', (next) => {
      if (next === 'active') load().catch(() => {});
    });
    const notifSub = Notifications.addNotificationReceivedListener(() => {
      load().catch(() => {});
    });
    return () => {
      clearInterval(pollId);
      appStateSub.remove();
      notifSub.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      // Build 47 — write through the canonical store so Dashboard
      // re-renders too.  Backend returns the full member object.
      if (r?.data?.id) memberStore.upsertOne(r.data);
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
      if (r?.data?.id) memberStore.upsertOne(r.data);
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
      if (r?.data?.id) memberStore.upsertOne(r.data);
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
      if (r?.data?.id) memberStore.upsertOne(r.data);
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
          // Build #59 — immediate dashboard refresh after delete.
          // Previously the dashboard waited up to a minute for the
          // next /members poll to notice the deletion, so caregivers
          // saw the removed row lingering.  Fix: drop the member
          // from the canonical store client-side the moment the
          // DELETE returns, so the dashboard renders the deletion
          // on the very next paint (no round-trip wait).
          try {
            await api.delete(`/members/${id}`);
          } catch (_e) {}
          try {
            // Local-side eviction from the canonical store.
            if (id) memberStore.remove(String(id));
          } catch (_e) {}
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
        <TouchableOpacity testID="member-back" onPress={() => router.back()} style={styles.iconBtn} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Icon name="arrow-back" size={28} color={Colors.textPrimary} />
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
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Location</Text>
            <TouchableOpacity
              testID="member-refresh-location"
              onPress={onManualRefresh}
              activeOpacity={0.85}
              disabled={locationRefreshing}
              style={[styles.refreshChip, locationRefreshing && styles.refreshChipDisabled]}
            >
              {locationRefreshing ? (
                <>
                  <ActivityIndicator size="small" color={Colors.primary} />
                  <Text style={styles.refreshChipText}>Refreshing…</Text>
                </>
              ) : (
                <Text style={styles.refreshChipText}>🔄 Refresh</Text>
              )}
            </TouchableOpacity>
          </View>
          <View style={styles.locationCard}>
            {((member as any).location_sharing_enabled === false) ? (
              // Build #56 — Location Sharing Disabled banner replaces
              // the entire pin/map surface.  Caregivers see an
              // unambiguous privacy statement, not stale coords.
              <View testID="member-sharing-disabled" style={styles.sharingOffBanner}>
                <Text style={styles.sharingOffEmoji}>🔒</Text>
                <Text style={styles.sharingOffTitle}>Location Sharing Off</Text>
                <Text style={styles.sharingOffBody}>
                  This family member has chosen not to share their location.
                </Text>
              </View>
            ) : (
              <>
                <View style={styles.locRow}>
                  <View style={styles.locPinBubble}><Text style={styles.locPinEmoji}>📍</Text></View>
                  <View style={{ flex: 1, marginLeft: 14 }}>
                    <Text style={styles.locName}>{member.location_name || 'Unknown location'}</Text>
                    {/* Build 54 — health-first design.  The pill is the only
                        tracking signal shown on the primary member surface;
                        per-tick freshness lives in Diagnostics.
                        Build #56 — locationSharingEnabled prop is forwarded
                        so the pill can flip to "🔒 Location sharing off"
                        atomically with the banner above. */}
                    <TrackingStatusPill
                      hasCoords={typeof member.latitude === 'number' && typeof member.longitude === 'number'}
                      lastSeenIso={member.last_seen}
                      locationSharingEnabled={(member as any).location_sharing_enabled}
                      screen="member"
                      size="compact"
                      style={styles.locStatusPill}
                      testID="member-tracking-status"
                    />
                  </View>
                </View>
                <View style={{ marginTop: 12 }}>
                  <MemberMap
                    latitude={member.latitude}
                    longitude={member.longitude}
                    memberName={member.name}
                    locationName={member.location_name || undefined}
                    memberId={member.id}
                    height={220}
                  />
                </View>
                <TouchableOpacity testID="member-get-directions" onPress={openDirections} activeOpacity={0.85} style={styles.directionsBtn}>
                  <Text style={styles.directionsEmoji}>🗺</Text>
                  <Text style={styles.directionsText}>Get Directions</Text>
                </TouchableOpacity>
              </>
            )}
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
                  📱 Receives an SMS the moment {member?.name} triggers an SOS.
                </Text>
              </View>
            ) : (
              <View testID="ec-empty">
                <Text style={styles.ecEmpty}>No emergency contact set</Text>
                <Text style={styles.ecHelp}>
                  Add a phone number so a designated person gets an SMS alert during an SOS emergency.
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
                  <View style={{ flex: 1, minWidth: 180 }}>
                    <TimePicker12
                      testIDPrefix="checkin-time-picker"
                      value={member.daily_checkin_time || checkinDraftTime}
                      onChange={setCheckinDraftTime}
                    />
                  </View>
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
  iconBtn: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border },
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
  locSub: { fontSize: 12, color: Colors.textTertiary, marginTop: 4 },
  locStatusPill: { marginTop: 6 },
  locFreshRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  locFreshRefreshing: { fontSize: 12, color: Colors.primary, fontWeight: '700' },
  refreshChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999,
    backgroundColor: Colors.tertiary,
    minHeight: 32,
  },
  refreshChipDisabled: { opacity: 0.7 },
  refreshChipText: { fontSize: 12, fontWeight: '700', color: Colors.primary },
  locDivider: { height: 1, backgroundColor: Colors.border, marginVertical: 12 },
  locMetaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4 },
  locMetaLabel: { fontSize: 12, fontWeight: '700', color: Colors.textTertiary, textTransform: 'uppercase', letterSpacing: 0.5 },
  locMetaValue: { fontSize: 13, color: Colors.textPrimary, fontWeight: '600' },
  directionsBtn: { marginTop: 12, height: 48, borderRadius: 14, backgroundColor: Colors.primary, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  directionsEmoji: { fontSize: 16 },
  directionsText: { color: Colors.surface, fontSize: 15, fontWeight: '700' },
  // Build #56 — Location Sharing Off state, shown in place of the pin
  // + map when the member has intentionally disabled sharing.
  sharingOffBanner: {
    alignItems: 'center',
    paddingVertical: 26,
    paddingHorizontal: 20,
    gap: 6,
  },
  sharingOffEmoji: { fontSize: 40, marginBottom: 6 },
  sharingOffTitle: { fontSize: 17, fontWeight: '800', color: Colors.textPrimary, textAlign: 'center' },
  sharingOffBody: { fontSize: 13.5, color: Colors.textSecondary, textAlign: 'center', lineHeight: 19, marginTop: 4, paddingHorizontal: 12 },
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
