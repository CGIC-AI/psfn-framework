import policy from "./credential-policy.json" with { type: "json" };

// The Hub ships independently; a parity test binds this packaged policy to Helm.
const placeholder = new RegExp(policy.placeholderPattern.replace("(?i)", ""), "i");

export function assertStrongHubCredential(value: string, role: string): void {
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
