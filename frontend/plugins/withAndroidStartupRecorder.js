const { withMainActivity, withMainApplication } = require('expo/config-plugins');

const MARKER = 'KinnshipStartupDiagnostics';
const RECORDER = 'expo.modules.startupdiagnostics.StartupDiagnosticsRecorder';

function insertInFunction(contents, signature, before, after) {
  const signatureIndex = contents.indexOf(signature);
  if (signatureIndex < 0) return contents;
  const open = contents.indexOf('{', signatureIndex);
  if (open < 0) return contents;
  let depth = 0;
  for (let index = open; index < contents.length; index += 1) {
    if (contents[index] === '{') depth += 1;
    if (contents[index] === '}') depth -= 1;
    if (depth === 0) {
      return `${contents.slice(0, open + 1)}${before}${contents.slice(open + 1, index)}${after}${contents.slice(index)}`;
    }
  }
  return contents;
}

function injectMainApplication(contents) {
  if (contents.includes(MARKER)) return contents;
  return insertInFunction(
    contents,
    'override fun onCreate()',
    `\n    // ${MARKER}: truthful boundary before Application superclass initialization.\n    ${RECORDER}.startNewRun(this)\n    ${RECORDER}.record("native_application_on_create_started", null)\n`,
    `\n    // ${MARKER}: this method has completed its generated Application initialization.\n    ${RECORDER}.record("native_application_on_create_completed", null)\n  `,
  );
}

function injectMainActivity(contents) {
  if (contents.includes(MARKER)) return contents;
  const next = insertInFunction(
    contents,
    'override fun onCreate(',
    `\n    // ${MARKER}: Activity callback entered; this does not claim splash or React readiness.\n    ${RECORDER}.record("native_activity_on_create_started", null)\n`,
    `\n    ${RECORDER}.record("native_activity_on_create_completed", null)\n  `,
  );
  if (next === contents) return contents;
  const classEnd = next.lastIndexOf('}');
  return `${next.slice(0, classEnd)}
  override fun onWindowFocusChanged(hasFocus: Boolean) {
    ${RECORDER}.record("native_activity_window_focus_changed", "{\\"hasWindowFocus\\":" + hasFocus + "}")
    super.onWindowFocusChanged(hasFocus)
  }
${next.slice(classEnd)}`;
}

module.exports = function withAndroidStartupRecorder(config) {
  config = withMainApplication(config, (cfg) => {
    cfg.modResults.contents = injectMainApplication(cfg.modResults.contents);
    return cfg;
  });
  return withMainActivity(config, (cfg) => {
    cfg.modResults.contents = injectMainActivity(cfg.modResults.contents);
    return cfg;
  });
};

module.exports.injectMainApplication = injectMainApplication;
module.exports.injectMainActivity = injectMainActivity;