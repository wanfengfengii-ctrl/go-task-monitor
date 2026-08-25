// Diagnosis commands are public evidence.  Internal reproduction gates such
// as MODEL_REPRO must not become part of the command a user receives.
export function normalizeDiagnosisPublicCommand(command) {
  let value = String(command || '').trim();
  // Keep removing only leading, explicitly known pipeline-only assignments.
  // Other assignments remain part of the public command and are validated by
  // the normal direct-command checks.
  while (/^(?:MODEL_REPRO=\S+|GOTOOLCHAIN=local)\s+/i.test(value)) {
    value = value.replace(/^(?:MODEL_REPRO=\S+|GOTOOLCHAIN=local)\s+/i, '');
  }
  return value;
}

const MODEL_REPRO_SKIP_PATTERN = /os\.Getenv\(\s*"MODEL_REPRO"\s*\)\s*!=\s*"1"/g;

// Older diagnosis fixtures used MODEL_REPRO to keep their test out of the
// ordinary suite.  Once the public command is a direct go test, the guard must
// default to running.  Keep the explicit MODEL_REPRO=0 escape for the ordinary
// project-wide suite, while making the public command self-contained.
export function normalizeDiagnosisVerificationSource(source) {
  const original = String(source || '');
  const value = original.replace(MODEL_REPRO_SKIP_PATTERN, 'os.Getenv("MODEL_REPRO") == "0"');
  return value;
}
