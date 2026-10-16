import { AppState, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import { api, getCurrentToken } from './api';
import { trackingIntentEpoch } from './androidTrackingRecovery';
import { recordLocationUploadSuccess } from './locationUploadSuccess';
import * as memberStore from './store/memberStore';

/**
 * Capture authority BEFORE acquisition, never inside a watcher callback.
 * Android uses the same persist:false / receipt-bound contract as recovery.
 * iOS Expo one-shots have no native persistence/HTTP side effects.
 */
export async function refreshForegroundLocation(
  source: string, isCurrent: () => boolean = () => true,
): Promise<void> {
  if (Platform.OS === 'web' || AppState.currentState !== 'active' || !isCurrent()) return;
  const epoch = trackingIntentEpoch();
  if (Platform.OS === 'android') {
    const engine = require('./locationEngine') as typeof import('./locationEngine');
    // The guarded engine owns identity, permission and generation validation.
    if (isCurrent() && epoch === trackingIntentEpoch()) await engine.requestFreshLocation(source);
    return;
  }
  const token = await getCurrentToken();
  if (!token) return;
  const current = async () => isCurrent() && AppState.currentState === 'active'
    && epoch === trackingIntentEpoch() && await getCurrentToken() === token
    && await AsyncStorage.getItem('@kinnship/location_sharing_off_v1') !== '1';
  const identity = async () => {
    const [u, m, p] = await Promise.all([
      api.get('/auth/me'), api.get('/members'), api.get('/me/preferences'),
    ]);
    if (p.data?.location_sharing_enabled !== true) throw new Error('foreground_sharing_unverified');
    const member = m.data?.find((item: any) => item.user_id === u.data?.id);
    if (!member) throw new Error('foreground_owner_unverified');
    return { owner: `${u.data.id}:${member.id}`, memberId: member.id,
      generation: member.location_consent_generation ?? 0 };
  };
  if (!await current()) return;
  const owner = await identity();
  if (!await current()) return;
  if ((await Location.getForegroundPermissionsAsync()).status !== 'granted') return;
  if (!await current()) return;
  const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
  const latest = await identity();
  if (!await current() || latest.owner !== owner.owner || latest.generation !== owner.generation) return;
  if ((await Location.getForegroundPermissionsAsync()).status !== 'granted' || !await current()) return;
  const capturedAt = position.timestamp;
  // Unknown capture provenance is not permission to invent Date.now().
  if (!Number.isFinite(capturedAt) || capturedAt <= 0 || capturedAt > Date.now() + 5000) return;
  // Capture the JWT rather than letting an interceptor substitute a new session
  // after our final fence. The backend also atomically checks consent lifetime.
  if (!isCurrent() || AppState.currentState !== 'active' || epoch !== trackingIntentEpoch()) return;
  const result = await fetch(`${api.defaults.baseURL}/members/${owner.memberId}/location`, {
    method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ latitude: position.coords.latitude, longitude: position.coords.longitude,
      timestamp: new Date(capturedAt).toISOString(), consent_generation: owner.generation }),
  });
  if (!result.ok) throw new Error(`foreground_upload_http_${result.status}`);
  const response = { data: await result.json() };
  if (!await current()) return;
  if (response.data?.location_write_accepted === true
    && Date.parse(response.data.coordinate_captured_at) === capturedAt) {
    await recordLocationUploadSuccess();
    memberStore.upsertOne(response.data);
  }
}
