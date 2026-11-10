/**
 * The explicitly selected diagnostic version also enables deep instrumentation.
 * No per-version allowlist: future diagnostic profiles use the same rule.
 * Unset/invalid values preserve normal production identity and instrumentation.
 */
function diagnosticBuild(env = process.env) {
  const raw = env.KINNSHIP_DIAGNOSTIC_BUILD;
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) return null;
  const code = Number(raw);
  return Number.isSafeInteger(code) && code >= 71 && code <= 2100000000 ? code : null;
}

module.exports = { diagnosticBuild };
