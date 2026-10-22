/** Optional evidence extension. Build 70 remains usable and sends no trace header. */
import { readRequestOrigins, requestOriginAvailable } from './requestOrigin';
type EvidenceModule = {
  evidenceVersion?: () => number;
  evidenceRecord?: (channel: string, stage: string, id: string, detail: string) => void;
  evidenceRead?: () => string;
};
function extension(): EvidenceModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const expo = require('expo') as { requireOptionalNativeModule?: (name: string) => EvidenceModule | null };
    const module = expo.requireOptionalNativeModule?.('StartupDiagnostics');
    return module?.evidenceVersion?.() === 1 ? module : null;
  } catch { return null; }
}
export function startupTraceId(): string | null {
  if (!extension()) return null;
  // Opaque correlation only: no installation, owner, token or location identity.
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}
export function recordEvidence(
  channel: 'http' | 'gps', stage: string, id: string | null,
  detail: Record<string, number | boolean | string | null> = {},
): void {
  try { extension()?.evidenceRecord?.(channel, stage, id ?? '', JSON.stringify(detail)); } catch { /* observation only */ }
}
export function readEvidenceTrace(): unknown {
  try {
    const module = extension();
    return module?.evidenceRead ? { ...JSON.parse(module.evidenceRead()),
      ...(requestOriginAvailable() ? { requestOrigins: readRequestOrigins() } : {}) }
      : { available: false, reason: 'native_evidence_extension_required' };
  } catch { return { available: false, reason: 'evidence_read_failed' }; }
}
