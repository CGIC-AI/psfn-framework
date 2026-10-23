import policy from '../../../deploy/helm/psfn/files/credential-policy.json' with { type: 'json' };

// Helm consumes the same policy file. Keep diagnostics to role names only.
const placeholder = new RegExp(policy.placeholderPattern.replace('(?i)', ''), 'i');

export function assertStrongCredential(value: string, role: string): void {
  const invalid = value.length < policy.minimumLength || value.length > policy.maximumLength
    || /[^!-~]/u.test(value) || placeholder.test(value)
    || new Set(value).size < policy.minimumDistinctCharacters;
  let repeated = false;
  if (!invalid) {
    for (let size = 1; size <= value.length / 2; size += 1) {
      if (value.length % size === 0 && value.slice(0, size).repeat(value.length / size) === value) {
        repeated = true;
        break;
      }
    }
  }
  if (invalid || repeated) {
    throw new Error(`${role} credential must be ${policy.minimumLength}-${policy.maximumLength} printable ASCII characters with at least ${policy.minimumDistinctCharacters} distinct characters; placeholders and repeated patterns are forbidden. Generate a fresh random value.`);
  }
}

export function assertDistinctCredentials(credentials: Record<string, string | undefined>): void {
  const seen = new Set<string>();
  for (const [role, value] of Object.entries(credentials)) {
    if (value === undefined) continue;
    assertStrongCredential(value, role);
    if (seen.has(value)) throw new Error(`${role} credential must not reuse another role's credential`);
    seen.add(value);
  }
}
