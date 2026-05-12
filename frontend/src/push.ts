import { useEffect, useState } from 'react';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { api } from './api';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export async function ensureNotificationChannel() {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'KinnectCare alerts',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#1B5E35',
    });
  }
}

export async function registerForPushNotifications(): Promise<string | null> {
  try {
    if (Platform.OS === 'web') return null;
    if (!Device.isDevice) return null;

    await ensureNotificationChannel();

    const { status: existing } = await Notifications.getPermissionsAsync();
    let finalStatus = existing;
    if (existing !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== 'granted') return null;

    const projectId =
      process.env.EXPO_PUBLIC_EAS_PROJECT_ID ||
      Constants?.expoConfig?.extra?.eas?.projectId ||
      (Constants as any)?.easConfig?.projectId;

    const validProjectId = projectId && projectId !== 'REPLACE_WITH_EAS_PROJECT_ID' ? projectId : undefined;

    const token = validProjectId
      ? (await Notifications.getExpoPushTokenAsync({ projectId: validProjectId })).data
      : (await Notifications.getExpoPushTokenAsync()).data;

    if (token) {
      await api.post('/auth/push-token', { token, platform: Platform.OS }).catch(() => {});
    }
    return token;
  } catch (_e) {
    return null;
  }
}

export function useNotificationListeners(onAlert?: (data: any) => void) {
  const [last, setLast] = useState<Notifications.Notification | null>(null);
  useEffect(() => {
    const recv = Notifications.addNotificationReceivedListener(n => setLast(n));
    const resp = Notifications.addNotificationResponseReceivedListener(r => {
      const data = r.notification.request.content.data;
      onAlert?.(data);
    });
    return () => {
      recv.remove();
      resp.remove();
    };
  }, [onAlert]);
  return last;
}
