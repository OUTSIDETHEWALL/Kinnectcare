/**
 * Build #55 — Me tab (full rewrite).
 *
 * Personal, single-user settings.  Family-scoped settings intentionally
 * live under the Family tab per the mental-model rule:
 *   "Me = me, Family = everyone."
 *
 * Sections:
 *   • Account        — editable Name / Time zone, read-only Email + Role
 *   • Plan           — Stripe status + Manage Subscription
 *   • Notifications  — Push registration status + Retry, Quiet Hours
 *   • Security       — Change / Remove PIN, Biometrics toggle
 *   • Privacy        — Location Sharing toggle (kills background uploads)
 *   • Legal          — Privacy, Terms
 *   • Advanced       — Diagnostics
 *   • Sign out
 *   • Danger Zone    — Delete Account
 *
 * The legacy /settings route is removed as of this build; every entry
 * point in the app now lands here.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert, Modal,
  TextInput, ActivityIndicator, Platform, Switch, Pressable,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Constants from 'expo-constants';
import { Icon } from '../../src/Icon';
import { Colors } from '../../src/theme';
import { useAuth } from '../../src/AuthContext';
import { api, getBillingStatus, BillingStatus } from '../../src/api';
import { APP_NAME, COMPANY_NAME } from '../../src/legal';
import {
  getPushStatus, subscribePushStatus, PushStatus, registerForPushNotifications,
} from '../../src/push';
import { hasPinForUser, clearPin } from '../../src/pinAuth';
import { clearPinSetupDismissed } from '../../src/pinSetupPrompt';
import {
  getBiometricCapability, isBiometricEnabledForUser, enableBiometricForUser,
  disableBiometricForUser, promptBiometric, labelForBiometricType,
} from '../../src/biometrics';
import { getPreferences, updatePreferences } from '../../src/preferences';
import {
  setLocationSharingEnabled, isLocationSharingEnabled,
  stopBackgroundLocation, startBackgroundLocation,
} from '../../src/backgroundLocation';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ------ Small pieces ---------------------------------------------------

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <Text style={styles.sectionLabel}>{children}</Text>;
}

function NavRow(props: {
  label: string;
  icon: string;
  onPress: () => void;
  testID?: string;
  secondary?: string | null;
  danger?: boolean;
  disabled?: boolean;
}) {
  const { label, icon, onPress, testID, secondary, danger, disabled } = props;
  return (
    <TouchableOpacity
      testID={testID}
      onPress={disabled ? undefined : onPress}
      style={[styles.row, disabled && styles.rowDisabled]}
      activeOpacity={disabled ? 1 : 0.75}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Text style={styles.rowIcon}>{icon}</Text>
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowLabel, danger && styles.rowLabelDanger, disabled && styles.rowLabelDisabled]}>
          {label}
        </Text>
        {secondary ? <Text style={styles.rowSecondary}>{secondary}</Text> : null}
      </View>
      {!disabled ? <Icon name="chevron-forward" size={20} color={Colors.textTertiary} /> : null}
    </TouchableOpacity>
  );
}

function ToggleRow(props: {
  label: string;
  icon: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
  testID?: string;
  secondary?: string | null;
  disabled?: boolean;
}) {
  const { label, icon, value, onValueChange, testID, secondary, disabled } = props;
  return (
    <View style={styles.row}>
      <Text style={styles.rowIcon}>{icon}</Text>
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowLabel, disabled && styles.rowLabelDisabled]}>{label}</Text>
        {secondary ? <Text style={styles.rowSecondary}>{secondary}</Text> : null}
      </View>
      <Switch
        testID={testID}
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        trackColor={{ false: '#D0D5D0', true: Colors.primary }}
        thumbColor={Platform.OS === 'android' ? Colors.surface : undefined}
      />
    </View>
  );
}

function EditableRow(props: {
  label: string;
  value: string;
  onEdit: () => void;
  testID?: string;
}) {
  return (
    <Pressable onPress={props.onEdit} style={styles.readRow} testID={props.testID}>
      <View style={{ flex: 1 }}>
        <Text style={styles.readLabel}>{props.label}</Text>
        <Text style={styles.readValue} numberOfLines={1}>{props.value || '—'}</Text>
      </View>
      <Text style={styles.editHint}>Edit ›</Text>
    </Pressable>
  );
}

function ReadRow({ label, value }: { label: string; value: string | null | undefined }) {
  // Build #56 — consistent stacked layout: label ABOVE value.  Prior
  // build put email/role on the same row as their label which read
  // as crowded next to the stacked Name/Time zone rows.  Now every
  // account field uses the same rhythm.
  return (
    <View style={styles.readRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.readLabel}>{label}</Text>
        <Text style={styles.readValue} numberOfLines={1}>{value || '—'}</Text>
      </View>
    </View>
  );
}

// ------ Screen ---------------------------------------------------------

export default function MeScreen() {
  const router = useRouter();
  const { user, logout, refreshUser } = useAuth();

  // Plan card state
  const [billing, setBilling] = useState<BillingStatus | null>(null);

  // Push registration state
  const [pushStatus, setPushStatus] = useState<PushStatus>(getPushStatus());
  const [pushRetrying, setPushRetrying] = useState(false);

  // PIN + biometric state
  const [pinOn, setPinOn] = useState<boolean>(false);
  const [bioSupported, setBioSupported] = useState(false);
  const [bioLabel, setBioLabel] = useState('Biometrics');
  // Build #56 — enumerate ALL biometric types the device supports +
  // has enrolled, so caregivers see "Fingerprint or Face Unlock"
  // when both are set up (many Android phones ship both sensors).
  const [bioTypes, setBioTypes] = useState<Array<'face' | 'fingerprint' | 'iris'>>([]);
  const [bioOn, setBioOn] = useState(false);

  // Location sharing preference
  const [locSharing, setLocSharing] = useState<boolean>(true);
  const [locBusy, setLocBusy] = useState(false);

  // Edit-name modal
  const [nameOpen, setNameOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [nameBusy, setNameBusy] = useState(false);
  const [nameErr, setNameErr] = useState<string | null>(null);

  // Edit-timezone modal
  const [tzOpen, setTzOpen] = useState(false);
  const [tzDraft, setTzDraft] = useState('');
  const [tzBusy, setTzBusy] = useState(false);
  const [tzErr, setTzErr] = useState<string | null>(null);

  // Delete-account modal
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // ---- Data loaders ----
  useEffect(() => {
    (async () => {
      try { setBilling(await getBillingStatus()); } catch (_e) {}
    })();
  }, []);

  useEffect(() => subscribePushStatus(setPushStatus), []);

  // Refresh PIN / biometric / preference state whenever the tab
  // regains focus (user may have just returned from pin-setup).
  useFocusEffect(
    React.useCallback(() => {
      let cancelled = false;
      (async () => {
        if (!user?.id) return;
        const [pin, cap, bioEnabled, sharing, prefs] = await Promise.all([
          hasPinForUser(user.id),
          getBiometricCapability(),
          isBiometricEnabledForUser(user.id),
          isLocationSharingEnabled(),
          getPreferences(),
        ]);
        if (cancelled) return;
        setPinOn(pin);
        setBioSupported(cap.supported && cap.enrolled);
        setBioLabel(cap.typeLabel);
        setBioTypes(cap.availableTypes);
        setBioOn(bioEnabled && pin);
        // Server preference is the source of truth on mount; the
        // local flag mirrors it so the background task can see it.
        setLocSharing(!!prefs.location_sharing_enabled && sharing);
        try { await setLocationSharingEnabled(!!prefs.location_sharing_enabled); } catch (_e) {}
      })();
      return () => { cancelled = true; };
    }, [user?.id])
  );

  // ---- Handlers ----

  const retryPushRegistration = async () => {
    setPushRetrying(true);
    try { await registerForPushNotifications(); } finally { setPushRetrying(false); }
  };

  const openEditName = () => {
    setNameDraft(user?.full_name || '');
    setNameErr(null);
    setNameOpen(true);
  };

  const saveName = async () => {
    const v = nameDraft.trim();
    if (v.length < 2) { setNameErr('Name must be at least 2 characters.'); return; }
    if (v.length > 80) { setNameErr('Name is too long.'); return; }
    setNameBusy(true);
    setNameErr(null);
    try {
      await api.patch('/auth/me', { full_name: v });
      await refreshUser();
      setNameOpen(false);
    } catch (e: any) {
      setNameErr(e?.response?.data?.detail || e?.message || 'Could not update your name.');
    } finally {
      setNameBusy(false);
    }
  };

  const openEditTimezone = () => {
    setTzDraft(user?.timezone || 'UTC');
    setTzErr(null);
    setTzOpen(true);
  };

  const saveTimezone = async () => {
    const v = tzDraft.trim();
    if (!v) { setTzErr('Time zone is required.'); return; }
    setTzBusy(true);
    setTzErr(null);
    try {
      await api.patch('/auth/me', { timezone: v });
      await refreshUser();
      setTzOpen(false);
    } catch (e: any) {
      setTzErr(e?.response?.data?.detail || e?.message || 'Could not update your time zone.');
    } finally {
      setTzBusy(false);
    }
  };

  const onToggleBiometrics = async (next: boolean) => {
    if (!user?.id) return;
    if (next) {
      // Enabling — verify capability + confirm the user is present.
      const cap = await getBiometricCapability();
      if (!cap.supported || !cap.enrolled) {
        Alert.alert(
          'Not available',
          `${cap.typeLabel} isn't set up on this device. Add a fingerprint or face in your phone's Settings, then try again.`,
        );
        return;
      }
      // Require a fresh biometric success before we save the pref —
      // otherwise a locked device could enable it silently.
      const res = await promptBiometric(`Confirm ${cap.typeLabel} for Kinnship`);
      if (!res.ok) {
        if (res.reason !== 'cancel') {
          Alert.alert('Could not verify', res.message || `Try again — we need to confirm your ${cap.typeLabel} works before enabling it.`);
        }
        return;
      }
      await enableBiometricForUser(user.id);
      setBioOn(true);
    } else {
      await disableBiometricForUser(user.id);
      setBioOn(false);
    }
  };

  const onToggleLocationSharing = async (next: boolean) => {
    if (!user?.id || locBusy) return;
    setLocBusy(true);
    try {
      // Persist the server side FIRST so a second device sees it.
      await updatePreferences({ location_sharing_enabled: next } as any);
      await setLocationSharingEnabled(next);
      setLocSharing(next);
      if (next) {
        // Try to resume the background task (best-effort — needs
        // location permissions which the onboarding flow already
        // secured).  We use the cached member id.
        try {
          const memberId = await AsyncStorage.getItem('kc_my_member_id_v1');
          if (memberId) await startBackgroundLocation(memberId);
        } catch (_e) {}
      } else {
        // Immediately stop the OS-owned task so no further coords
        // leave the device.  New task ticks that fire before this
        // returns will also see the sharing-off flag and short-
        // circuit — belt AND suspenders.
        try { await stopBackgroundLocation(); } catch (_e) {}
        Alert.alert(
          'Location sharing off',
          'Your family will see “Location sharing disabled.” Turn it back on anytime.',
        );
      }
    } catch (e: any) {
      Alert.alert('Could not update', e?.response?.data?.detail || e?.message || 'Please try again.');
      // Revert the toggle if the server rejected it.
      setLocSharing(!next);
      try { await setLocationSharingEnabled(!next); } catch (_e) {}
    } finally {
      setLocBusy(false);
    }
  };

  const onRemovePin = () => {
    if (!user?.id) return;
    Alert.alert(
      'Remove PIN?',
      "You'll sign in with an emailed 6-digit code each time you open the app. Biometric unlock will also be disabled.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              await clearPin(user.id);
              await clearPinSetupDismissed(user.id);
              // Biometrics require an underlying PIN — remove them too.
              await disableBiometricForUser(user.id);
              setPinOn(false);
              setBioOn(false);
              Alert.alert('PIN removed', 'You can set a new PIN anytime from Me → Security.');
            } catch (e: any) {
              Alert.alert('Error', e?.message || 'Could not remove PIN.');
            }
          },
        },
      ],
    );
  };

  const confirmLogout = () => {
    Alert.alert('Sign out?', 'You will need to sign back in with your email.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: async () => {
          try { await logout?.(); } catch (_e) {}
          router.replace('/');
        },
      },
    ]);
  };

  const openDelete = () => {
    setDeleteConfirmText('');
    setDeleteError(null);
    setDeleteOpen(true);
  };

  const performDelete = async () => {
    if (deleting) return;
    if (deleteConfirmText.trim().toUpperCase() !== 'DELETE') {
      setDeleteError('Please type DELETE exactly to confirm.');
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.delete('/auth/account', { data: { confirm: 'DELETE' } });
      setDeleteOpen(false);
      await logout();
      router.replace('/');
    } catch (e: any) {
      setDeleteError(e?.response?.data?.detail || e?.message || 'Failed to delete account. Please try again.');
    } finally {
      setDeleting(false);
    }
  };

  // ---- Derived data ----

  const planLabel =
    billing?.plan === 'family_plan'
      ? (billing?.plan_label || (billing?.interval === 'year' ? 'Annual Plan' : 'Monthly Plan'))
      : 'Free Plan';
  const limitLine = billing
    ? billing.member_limit === null
      ? `${billing.member_count} members · unlimited`
      : `${billing.member_count} of ${billing.member_limit} members used`
    : '—';

  function pushStatusCopy(s: PushStatus): { headline: string; sub: string; ok: boolean } {
    switch (s.state) {
      case 'registered':
        return { ok: true, headline: 'Notifications enabled', sub: "You'll receive SOS, medication, and family alerts." };
      case 'permission_denied':
        return { ok: false, headline: 'Permission denied', sub: 'Open phone Settings → Apps → Kinnship → Notifications → Allow.' };
      case 'no_project_id':
        return { ok: false, headline: 'Configuration error', sub: 'Missing EAS project ID. Reinstall the latest build.' };
      case 'unsupported':
        return { ok: false, headline: 'Not supported here', sub: `Push doesn't run on ${s.reason}. Install the device build.` };
      case 'token_error':
        return { ok: false, headline: 'Could not get push token', sub: s.error };
      case 'api_error':
        return { ok: false, headline: 'Could not save token to server', sub: s.error };
      default:
        return { ok: false, headline: 'Setting up notifications…', sub: 'Tap Retry below if this persists for more than a minute.' };
    }
  }
  const pushCopy = pushStatusCopy(pushStatus);

  const versionLine = useMemo(() => {
    const cfg = Constants.expoConfig as any;
    const appVersion = (cfg?.version as string | undefined) || '—';
    const buildNumber = Platform.OS === 'ios'
      ? (cfg?.ios?.buildNumber as string | number | undefined)
      : (cfg?.android?.versionCode as number | undefined);
    const buildStr = buildNumber === undefined || buildNumber === null ? '—' : String(buildNumber);
    return `Kinnship v${appVersion} (${buildStr})`;
  }, []);

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.title}>Me</Text>

        {/* Account — editable */}
        <SectionLabel>Account</SectionLabel>
        <View style={styles.card}>
          <EditableRow
            testID="me-edit-name"
            label="Name"
            value={(user as any)?.full_name || ''}
            onEdit={openEditName}
          />
          <ReadRow label="Email" value={user?.email as string} />
          <ReadRow
            label="Role"
            value={((user as any)?.role || 'member').replace(/^\w/, (c: string) => c.toUpperCase())}
          />
          <EditableRow
            testID="me-edit-timezone"
            label="Time zone"
            value={(user as any)?.timezone || 'UTC'}
            onEdit={openEditTimezone}
          />
        </View>

        {/* Plan */}
        <SectionLabel>Plan</SectionLabel>
        <View style={[styles.planCard, billing?.plan === 'family_plan' && styles.planCardPaid]}>
          <View style={styles.planNameRow}>
            <Text style={styles.planName}>{planLabel}</Text>
            <View style={[styles.planBadge, billing?.plan === 'family_plan' && styles.planBadgePaid]}>
              <Text style={[styles.planBadgeText, billing?.plan === 'family_plan' && { color: Colors.surface }]}>
                {billing?.plan === 'family_plan' ? '⭐ Active' : 'Free Tier'}
              </Text>
            </View>
          </View>
          <Text style={styles.planLimit}>{limitLine}</Text>
          {billing?.plan === 'family_plan' && billing?.current_period_end ? (
            <Text style={styles.planRenewal}>Renews {new Date(billing.current_period_end).toLocaleDateString()}</Text>
          ) : null}

          {billing?.plan !== 'family_plan' ? (
            <>
              <Text style={styles.planPitch}>
                Unlock unlimited family members, weekly compliance charts, and priority SOS push from $9.99/month — or save 17% with the annual plan.
              </Text>
              <TouchableOpacity
                testID="me-view-plans"
                style={styles.planCtaPrimary}
                onPress={() => router.push('/upgrade')}
                activeOpacity={0.85}
              >
                <Text style={styles.planCtaPrimaryText}>View Plans & Upgrade</Text>
                <Text style={styles.planCtaPrimaryArrow}>›</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="me-manage-plan-free"
                style={styles.planCtaSecondary}
                onPress={() => router.push('/manage-subscription')}
                activeOpacity={0.85}
              >
                <Text style={styles.planCtaSecondaryText}>Manage Subscription ›</Text>
              </TouchableOpacity>
            </>
          ) : (
            <TouchableOpacity
              testID="me-manage-plan"
              style={styles.planCtaSecondary}
              onPress={() => router.push('/manage-subscription')}
              activeOpacity={0.85}
            >
              <Text style={styles.planCtaSecondaryText}>Manage Subscription ›</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Notifications */}
        <SectionLabel>Notifications</SectionLabel>
        <View style={styles.card}>
          <View style={styles.pushRow} testID="me-push-row">
            <View style={{ flex: 1, paddingRight: 12 }}>
              <View style={styles.pushTitleRow}>
                <Text style={styles.pushIcon}>{pushCopy.ok ? '🔔' : '🔕'}</Text>
                <Text style={[styles.pushTitle, !pushCopy.ok && { color: Colors.error }]}>{pushCopy.headline}</Text>
              </View>
              <Text style={styles.pushSub}>{pushCopy.sub}</Text>
            </View>
            {!pushCopy.ok ? (
              <TouchableOpacity
                testID="me-push-retry"
                style={styles.pushRetryBtn}
                onPress={retryPushRegistration}
                disabled={pushRetrying}
                activeOpacity={0.85}
              >
                {pushRetrying ? <ActivityIndicator color={Colors.primary} /> : <Text style={styles.pushRetryText}>Retry</Text>}
              </TouchableOpacity>
            ) : null}
          </View>
          <NavRow
            testID="me-quiet-hours"
            icon="🌙"
            label="Quiet Hours"
            secondary="Silence non-emergency alerts at night"
            onPress={() => router.push('/quiet-hours')}
          />
        </View>

        {/* Security */}
        <SectionLabel>Security</SectionLabel>
        <View style={styles.card}>
          {pinOn ? (
            <>
              <NavRow
                testID="me-change-pin"
                icon="🔒"
                label="Change PIN"
                secondary="4-digit unlock for the app"
                onPress={async () => {
                  if (user?.id) { try { await clearPinSetupDismissed(user.id); } catch (_e) {} }
                  router.push('/(auth)/pin-setup' as any);
                }}
              />
              <NavRow
                testID="me-remove-pin"
                icon="🔓"
                label="Remove PIN"
                secondary="Sign in with an emailed code each time"
                onPress={onRemovePin}
                danger
              />
            </>
          ) : (
            <NavRow
              testID="me-setup-pin"
              icon="🔒"
              label="Set up 4-digit PIN"
              secondary="Fast unlock — no email code every time"
              onPress={async () => {
                if (user?.id) { try { await clearPinSetupDismissed(user.id); } catch (_e) {} }
                router.push('/(auth)/pin-setup' as any);
              }}
            />
          )}
          {pinOn && bioSupported ? (
            <ToggleRow
              testID="me-biometrics"
              icon={
                // Prefer the fingerprint glyph when fingerprint is one of
                // the enrolled types (matches the physical sensor most
                // Android caregivers rely on); fall back to the face
                // glyph for face-only devices.
                bioTypes.includes('fingerprint') ? '👆'
                  : bioTypes.includes('face') ? '🙂'
                  : '🔐'
              }
              label={(() => {
                // Build #56 — honest labeling.  If BOTH Face and
                // Fingerprint are enrolled, tell the user both work
                // (a single OS prompt accepts either).  Otherwise
                // name the specific method rather than a generic
                // "Biometrics" wording.
                const parts = bioTypes.map(labelForBiometricType);
                if (parts.length === 0) return `Unlock with ${bioLabel}`;
                if (parts.length === 1) return `Unlock with ${parts[0]}`;
                return `Unlock with ${parts.slice(0, -1).join(', ')} or ${parts.slice(-1)[0]}`;
              })()}
              secondary="A convenience option — your PIN still works."
              value={bioOn}
              onValueChange={onToggleBiometrics}
            />
          ) : null}
        </View>

        {/* Privacy — Location Sharing */}
        <SectionLabel>Privacy</SectionLabel>
        <View style={styles.card}>
          <ToggleRow
            testID="me-location-sharing"
            icon="📍"
            label="Location sharing"
            secondary={
              locSharing
                ? 'Your family can see your location on the map.'
                : "Family will see “Location sharing disabled.” No location data leaves this device."
            }
            value={locSharing}
            onValueChange={onToggleLocationSharing}
            disabled={locBusy}
          />
        </View>

        {/* Legal */}
        <SectionLabel>Legal</SectionLabel>
        <View style={styles.card}>
          <NavRow testID="me-privacy-policy" icon="🛡️" label="Privacy Policy" onPress={() => router.push('/privacy-policy')} />
          <NavRow testID="me-terms" icon="📄" label="Terms of Service" onPress={() => router.push('/terms-of-service')} />
        </View>

        {/* Advanced */}
        <SectionLabel>Advanced</SectionLabel>
        <View style={styles.card}>
          <NavRow
            testID="me-diagnostics"
            icon="🩺"
            label="Diagnostics"
            secondary="Developer tools — safe to explore"
            onPress={() => router.push('/diagnostics' as any)}
          />
        </View>

        {/* Session */}
        <TouchableOpacity testID="me-sign-out" style={styles.signOutBtn} onPress={confirmLogout} activeOpacity={0.85}>
          <Icon name="log-out-outline" size={20} color={Colors.error} />
          <Text style={styles.signOutText}>Sign out</Text>
        </TouchableOpacity>

        {/* Danger Zone */}
        <SectionLabel>Danger Zone</SectionLabel>
        <View style={[styles.card, { borderColor: '#F2C3C0' }]}>
          <NavRow testID="me-delete-account" icon="🗑" label="Delete Account" onPress={openDelete} danger />
        </View>
        <Text style={styles.dangerHint}>Permanently deletes your account and all associated data. Cannot be undone.</Text>

        {/* Footer */}
        <Text style={styles.footer}>{APP_NAME} · © {new Date().getFullYear()} {COMPANY_NAME}</Text>
        <Text style={styles.versionFooter} testID="me-version">{versionLine}</Text>
      </ScrollView>

      {/* -------- Modals -------- */}
      <EditModal
        visible={nameOpen}
        title="Edit name"
        placeholder="Your name"
        value={nameDraft}
        onChangeText={(t) => { setNameDraft(t); setNameErr(null); }}
        onCancel={() => !nameBusy && setNameOpen(false)}
        onSave={saveName}
        busy={nameBusy}
        error={nameErr}
        maxLength={80}
        autoCapitalize="words"
      />
      <EditModal
        visible={tzOpen}
        title="Edit time zone"
        placeholder="e.g. America/New_York"
        value={tzDraft}
        onChangeText={(t) => { setTzDraft(t); setTzErr(null); }}
        onCancel={() => !tzBusy && setTzOpen(false)}
        onSave={saveTimezone}
        busy={tzBusy}
        error={tzErr}
        maxLength={60}
        autoCapitalize="none"
        subtitle="Use an IANA identifier like America/New_York, Europe/London, or Asia/Tokyo."
      />

      <Modal
        visible={deleteOpen}
        transparent
        animationType="fade"
        onRequestClose={() => !deleting && setDeleteOpen(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard} testID="me-delete-account-modal">
            <Text style={styles.modalEmoji}>⚠️</Text>
            <Text style={styles.modalTitle}>Delete your account?</Text>
            <Text style={styles.modalBody}>
              This will permanently delete your Kinnship account and all related data:
              {'\n'}• family member profiles
              {'\n'}• medications, routines, and check-ins
              {'\n'}• alerts and SOS history
              {'\n'}• any active subscription (will be canceled)
              {'\n\n'}
              This action cannot be undone.
            </Text>
            <Text style={styles.modalConfirmLabel}>Type DELETE to confirm</Text>
            <TextInput
              testID="me-delete-confirm-input"
              value={deleteConfirmText}
              onChangeText={(t) => { setDeleteConfirmText(t); setDeleteError(null); }}
              autoCapitalize="characters"
              autoCorrect={false}
              placeholder="DELETE"
              placeholderTextColor={Colors.textTertiary}
              editable={!deleting}
              style={styles.modalInput}
            />
            {deleteError ? <Text style={styles.modalError}>{deleteError}</Text> : null}
            <TouchableOpacity
              testID="me-delete-account-confirm"
              style={[
                styles.modalDanger,
                (deleteConfirmText.trim().toUpperCase() !== 'DELETE' || deleting) && { opacity: 0.5 },
              ]}
              onPress={performDelete}
              disabled={deleting || deleteConfirmText.trim().toUpperCase() !== 'DELETE'}
              activeOpacity={0.85}
            >
              {deleting ? <ActivityIndicator color={Colors.surface} /> : <Text style={styles.modalDangerText}>Permanently delete account</Text>}
            </TouchableOpacity>
            <TouchableOpacity
              testID="me-delete-account-cancel"
              style={styles.modalSecondary}
              onPress={() => !deleting && setDeleteOpen(false)}
              disabled={deleting}
              activeOpacity={0.7}
            >
              <Text style={styles.modalSecondaryText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ------ EditModal ------------------------------------------------------

function EditModal(props: {
  visible: boolean;
  title: string;
  placeholder: string;
  value: string;
  onChangeText: (t: string) => void;
  onCancel: () => void;
  onSave: () => void;
  busy: boolean;
  error: string | null;
  maxLength: number;
  autoCapitalize: 'none' | 'sentences' | 'words' | 'characters';
  subtitle?: string;
}) {
  return (
    <Modal visible={props.visible} transparent animationType="fade" onRequestClose={props.onCancel}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>{props.title}</Text>
          {props.subtitle ? <Text style={styles.modalSubtitle}>{props.subtitle}</Text> : null}
          <TextInput
            value={props.value}
            onChangeText={props.onChangeText}
            placeholder={props.placeholder}
            placeholderTextColor={Colors.textTertiary}
            autoCapitalize={props.autoCapitalize}
            autoCorrect={false}
            editable={!props.busy}
            maxLength={props.maxLength}
            style={styles.modalInput}
          />
          {props.error ? <Text style={styles.modalError}>{props.error}</Text> : null}
          <TouchableOpacity
            style={[styles.modalPrimary, props.busy && { opacity: 0.6 }]}
            onPress={props.onSave}
            disabled={props.busy}
            activeOpacity={0.85}
          >
            {props.busy ? <ActivityIndicator color={Colors.surface} /> : <Text style={styles.modalPrimaryText}>Save</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={styles.modalSecondary} onPress={props.onCancel} disabled={props.busy} activeOpacity={0.7}>
            <Text style={styles.modalSecondaryText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ------ Styles ---------------------------------------------------------

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  body: { paddingHorizontal: 20, paddingBottom: 60, paddingTop: 8 },
  title: { fontSize: 28, fontWeight: '800', color: Colors.text, marginTop: 4, marginBottom: 16 },
  sectionLabel: {
    fontSize: 12, fontWeight: '800', letterSpacing: 0.8, textTransform: 'uppercase',
    color: Colors.textSecondary, marginTop: 20, marginBottom: 8, paddingHorizontal: 4,
  },
  card: {
    backgroundColor: Colors.surface, borderRadius: 14,
    borderWidth: 1, borderColor: Colors.border, overflow: 'hidden',
  },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border,
    minHeight: 56,
  },
  rowDisabled: { opacity: 0.55 },
  rowIcon: { fontSize: 18, width: 22, textAlign: 'center' },
  rowLabel: { fontSize: 15, fontWeight: '700', color: Colors.textPrimary },
  rowLabelDanger: { color: Colors.error },
  rowLabelDisabled: { color: Colors.textTertiary, fontWeight: '600' },
  rowSecondary: { fontSize: 12.5, color: Colors.textSecondary, marginTop: 2, lineHeight: 17 },

  readRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border,
    minHeight: 56,
  },
  readLabel: { fontSize: 12, color: Colors.textTertiary, fontWeight: '700', letterSpacing: 0.3 },
  readValue: { fontSize: 15, color: Colors.textPrimary, fontWeight: '600', marginTop: 2 },
  editHint: { fontSize: 13, fontWeight: '700', color: Colors.primary },

  signOutBtn: {
    marginTop: 28, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, paddingVertical: 14, borderRadius: 12,
    borderWidth: 1, borderColor: Colors.error, backgroundColor: Colors.surface,
  },
  signOutText: { color: Colors.error, fontSize: 15, fontWeight: '800' },

  dangerHint: { marginTop: 8, paddingHorizontal: 4, fontSize: 12, color: Colors.textTertiary, lineHeight: 18 },
  footer: { fontSize: 12, color: Colors.textTertiary, textAlign: 'center', marginTop: 22 },
  versionFooter: { fontSize: 11, color: Colors.textTertiary, textAlign: 'center', marginTop: 4, marginBottom: 8, opacity: 0.7 },

  // Plan card
  planCard: {
    backgroundColor: Colors.surface, borderRadius: 14, padding: 16,
    borderWidth: 1, borderColor: Colors.border,
    boxShadow: '0px 4px 12px rgba(27,94,53,0.08)' as any,
  },
  planCardPaid: { borderColor: Colors.primary, borderWidth: 2 },
  planNameRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 4 },
  planName: { fontSize: 16, fontWeight: '800', color: Colors.textPrimary },
  planLimit: { fontSize: 13, color: Colors.textSecondary, marginTop: 2 },
  planBadge: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 10, backgroundColor: Colors.tertiary },
  planBadgePaid: { backgroundColor: Colors.primary },
  planBadgeText: { fontSize: 12, fontWeight: '800', color: Colors.primary },
  planRenewal: { fontSize: 12, color: Colors.textTertiary, marginTop: 4, fontWeight: '600' },
  planPitch: { marginTop: 14, fontSize: 13, color: Colors.textSecondary, lineHeight: 19, paddingRight: 4 },
  planCtaPrimary: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    marginTop: 14, height: 50, borderRadius: 14, backgroundColor: Colors.primary,
    boxShadow: '0px 6px 12px rgba(27,94,53,0.2)' as any,
  },
  planCtaPrimaryText: { color: Colors.surface, fontSize: 15, fontWeight: '800' },
  planCtaPrimaryArrow: { color: Colors.surface, fontSize: 20, fontWeight: '700' },
  planCtaSecondary: {
    marginTop: 14, height: 46, borderRadius: 12, borderWidth: 2, borderColor: Colors.primary,
    alignItems: 'center', justifyContent: 'center', backgroundColor: 'transparent',
  },
  planCtaSecondaryText: { color: Colors.primary, fontSize: 14, fontWeight: '800' },

  // Push registration row
  pushRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border,
  },
  pushTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pushIcon: { fontSize: 18 },
  pushTitle: { fontSize: 15, fontWeight: '800', color: Colors.textPrimary },
  pushSub: { fontSize: 12.5, color: Colors.textSecondary, marginTop: 4, lineHeight: 18 },
  pushRetryBtn: {
    paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10,
    backgroundColor: Colors.tertiary, borderWidth: 1, borderColor: Colors.primary,
    minWidth: 64, alignItems: 'center',
  },
  pushRetryText: { fontSize: 13, fontWeight: '800', color: Colors.primary },

  // Modals
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center', padding: 22 },
  modalCard: {
    width: '100%', maxWidth: 380, backgroundColor: Colors.surface,
    borderRadius: 18, padding: 22,
    boxShadow: '0px 12px 28px rgba(0,0,0,0.25)' as any,
  },
  modalEmoji: { fontSize: 36, textAlign: 'center', marginBottom: 4 },
  modalTitle: { fontSize: 19, fontWeight: '800', color: Colors.textPrimary, textAlign: 'center' },
  modalSubtitle: { fontSize: 13, color: Colors.textSecondary, textAlign: 'center', marginTop: 6, marginBottom: 4, lineHeight: 18 },
  modalBody: { fontSize: 14, color: Colors.textSecondary, marginTop: 10, marginBottom: 14, lineHeight: 20 },
  modalConfirmLabel: {
    fontSize: 12, fontWeight: '800', color: Colors.textSecondary,
    letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 6,
  },
  modalInput: {
    backgroundColor: Colors.background, borderRadius: 12, padding: 14, marginTop: 12,
    fontSize: 16, fontWeight: '700', color: Colors.textPrimary,
    borderWidth: 1, borderColor: Colors.border,
  },
  modalError: { color: Colors.error, fontSize: 13, marginTop: 8, fontWeight: '600' },
  modalPrimary: {
    marginTop: 14, height: 52, backgroundColor: Colors.primary,
    borderRadius: 14, alignItems: 'center', justifyContent: 'center',
  },
  modalPrimaryText: { color: Colors.surface, fontSize: 16, fontWeight: '800' },
  modalDanger: {
    marginTop: 14, height: 52, backgroundColor: Colors.error,
    borderRadius: 14, alignItems: 'center', justifyContent: 'center',
  },
  modalDangerText: { color: Colors.surface, fontSize: 16, fontWeight: '800' },
  modalSecondary: { marginTop: 10, alignItems: 'center', paddingVertical: 12 },
  modalSecondaryText: { color: Colors.textSecondary, fontSize: 15, fontWeight: '600' },
});
