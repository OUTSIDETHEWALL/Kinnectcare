/**
 * File-only diagnostics export. Native modules are loaded inside the button
 * handler so an OTA on an older binary cannot crash Diagnostics at module load.
 * This feature requires a binary containing expo-file-system and expo-sharing.
 */
export function diagnosticsFileName(now: Date): string {
  const local = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map(value => String(value).padStart(2, '0')).join('');
  return `Kinnship_Diagnostics_${local}_${time}.txt`;
}

export function formatFullDiagnostics(payload: Record<string, unknown>, now: Date): string {
  return [
    'Kinnship Full Diagnostics',
    `Exported: ${now.toISOString()}`,
    `Local time: ${now.toString()}`,
    `Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown'}`,
    'Sensitive device and account information may be included. Share only with trusted support.',
    '',
    JSON.stringify(redactDiagnosticCredentials(payload), null, 2),
    '',
  ].join('\n');
}

/** Read-only deadlines: an unavailable native reader must not block sharing. */
export async function captureDiagnosticSource(
  read: () => Promise<unknown>,
  timeoutMs = 20000,
): Promise<{ data: unknown } | { error: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const data = await Promise.race([
      Promise.resolve().then(read),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Diagnostic read timed out after ${timeoutMs}ms; source unavailable for this export`)), timeoutMs);
      }),
    ]);
    return { data };
  } catch (error) {
    return { error: String(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function redactText(text: string): string {
  return text.replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [REDACTED]')
    .replace(/Basic\s+[^\s"',}]+/gi, 'Basic [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
    .replace(/(["']?(?:accessToken|refreshToken|apiKey|license|password)["']?\s*[:=]\s*["'])[^"']+/gi, '$1[REDACTED]')
    .replace(/([?&](?:token|access_token|refresh_token|api_key|key)=)[^&\s"']+/gi, '$1[REDACTED]');
}

/** Preserve diagnostic values; credentials are the only intentional omissions. */
export function redactDiagnosticCredentials(value: unknown): unknown {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : String(value);
  if (typeof value === 'string') {
    // Raw diagnostic buffers may contain JSON that a normal reader rejected.
    try { return JSON.stringify(redactDiagnosticCredentials(JSON.parse(value))); }
    catch { return redactText(value); }
  }
  if (Array.isArray(value)) return value.map(redactDiagnosticCredentials);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      (/^authorization$/i.test(key) && typeof item === 'string') ||
      /^(?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|license|password|cookie|set-cookie|x-api-key)$/i.test(key)
        ? '[REDACTED]' : redactDiagnosticCredentials(item),
    ]));
  }
  return value;
}

export async function readNativeSdkEvidence(): Promise<Record<string, unknown>> {
  try {
    // Already present in the production binary; do not call ready/start/setConfig.
    const sdk = require('react-native-background-geolocation').default;
    const [state, log, provider, powerSave] = await Promise.all([
      captureDiagnosticSource(() => sdk.getState()),
      captureDiagnosticSource(() => sdk.logger.getLog()),
      captureDiagnosticSource(() => sdk.getProviderState()),
      captureDiagnosticSource(() => sdk.isPowerSaveMode()),
    ]);
    // getState returns the SDK's full resolved configuration and runtime state.
    // No config whitelist: diagnostic settings must not silently disappear.
    const config = 'data' in state ? redactDiagnosticCredentials(state.data) : null;
    return {
      config,
      state: config,
      provider,
      powerSave,
      stateError: 'error' in state ? state.error : null,
      nativeLog: 'data' in log ? redactText(String(log.data)) : null,
      nativeLogError: 'error' in log ? log.error : null,
    };
  } catch (error) {
    return { unavailable: String(error) };
  }
}

export async function shareFullDiagnostics(
  payload: Record<string, unknown>,
  now: Date = new Date(),
): Promise<void> {
  let FileSystem: typeof import('expo-file-system');
  let Sharing: typeof import('expo-sharing');
  try {
    FileSystem = require('expo-file-system');
    Sharing = require('expo-sharing');
  } catch {
    throw new Error('File sharing requires the next Android app update. This installed binary does not include the sharing modules.');
  }
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('The native Share sheet is not available on this device.');
  }
  const file = new FileSystem.File(FileSystem.Paths.cache, diagnosticsFileName(now));
  file.create({ overwrite: true });
  file.write(formatFullDiagnostics(payload, now));
  await Sharing.shareAsync(file.uri, {
    mimeType: 'text/plain',
    UTI: 'public.plain-text',
    dialogTitle: 'Share All Diagnostics',
  });
}