import fs from 'fs';
import path from 'path';

const projectRoot = path.resolve(__dirname, '../..');

function source(relativePath: string): string {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

describe('native startup Diagnostics contract', () => {
  it('retains bounded safe failure metadata through every native recovery callback', () => {
    const recovery = source(
      'modules/startup-diagnostics/android/src/main/java/expo/modules/startupdiagnostics/NativeMotionRecovery.kt',
    );
    for (const stage of ['start_failed', 'ready_failed', 'movement_failed']) {
      expect(recovery).toContain(`settle("${stage}", error)`);
    }
    expect(recovery).toContain('trace("cleanup_failed", error)');
    expect(recovery).toContain('NativeRecoveryFailure.category(error)');
    expect(recovery).toContain('NativeRecoveryFailure.code(error)');
    expect(recovery).toContain('stage.put("failureCategory", failureCategory)');
    expect(recovery).toContain('stage.put("sdkCode", sdkCode)');
    expect(recovery).not.toMatch(/\.put\("(?:error|message)"\s*,\s*error/);
    expect(recovery).toContain('stages.length() - 24');
    expect(recovery).toContain('attempts.length() - 16');
  });

  it('keeps native checkpoint retrieval isolated from asynchronous Diagnostics reload', () => {
    const diagnostics = source('src/diagnosticsFull.tsx');

    expect(diagnostics).toContain('const nativeStartupSnapshot = readNativeStartupCheckpoints();');
    expect(diagnostics).toContain('setNativeStartup(nativeStartupSnapshot);');
    expect(diagnostics).toContain('diagnostics-native-startup-unavailable');
    expect(diagnostics).toContain('Native startup checkpoints unavailable or no records were retained.');
  });

  it('omits native checkpoint metadata when constructing the copied payload', () => {
    const diagnostics = source('src/diagnosticsFull.tsx');

    expect(diagnostics).toContain('function nativeStartupCheckpointsForCopy(snapshot: NativeStartupSnapshot)');
    expect(diagnostics).toContain('const omitMetadata = ({ metadata: _metadata, ...checkpoint }');
    expect(diagnostics).toContain('nativeStartupCheckpoints: nativeStartupCheckpointsForCopy(nativeStartup)');
    expect(diagnostics).toContain('records: snapshot.records.map(omitMetadata)');
    expect(diagnostics).toContain('{record.runId}');
    expect(diagnostics).toContain('{record.event}');
    expect(diagnostics).not.toContain('record.metadata');
  });
});