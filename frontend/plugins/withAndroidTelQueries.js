/**
 * Expo config plugin: adds <queries> to AndroidManifest.xml so the OS exposes
 * the dialer (and email/SMS apps) to our app on Android 11+ (API 30+).
 *
 * Without these queries, Linking.openURL('tel:911') silently fails on Android
 * 11+ because the new package-visibility model hides other apps unless we
 * explicitly declare which intents we use. This was the root cause of the
 * SOS flow appearing to succeed while never actually opening the dialer.
 *
 * Docs: https://developer.android.com/training/package-visibility
 */
const { withAndroidManifest } = require('expo/config-plugins');

function ensureQueries(androidManifest) {
  const manifest = androidManifest.manifest;
  if (!manifest.queries) manifest.queries = [{ intent: [] }];
  if (!manifest.queries[0].intent) manifest.queries[0].intent = [];
  const intents = manifest.queries[0].intent;

  const wanted = [
    { action: 'android.intent.action.DIAL', scheme: 'tel' },
    { action: 'android.intent.action.VIEW', scheme: 'tel' },
    { action: 'android.intent.action.SENDTO', scheme: 'mailto' },
    { action: 'android.intent.action.SENDTO', scheme: 'smsto' },
    { action: 'android.intent.action.VIEW', scheme: 'https' },
  ];

  for (const w of wanted) {
    const exists = intents.some((it) => {
      const actionName = it.action?.[0]?.$?.['android:name'];
      const dataScheme = it.data?.[0]?.$?.['android:scheme'];
      return actionName === w.action && dataScheme === w.scheme;
    });
    if (exists) continue;
    intents.push({
      action: [{ $: { 'android:name': w.action } }],
      data: [{ $: { 'android:scheme': w.scheme } }],
    });
  }
  return androidManifest;
}

module.exports = function withAndroidTelQueries(config) {
  return withAndroidManifest(config, (cfg) => {
    cfg.modResults = ensureQueries(cfg.modResults);
    return cfg;
  });
};
