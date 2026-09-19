/** Canonical query component that HTTP(S) URL serialization preserves unchanged. */
export function encodeCanonicalQueryComponent(value: string): string {
  // Browsers percent-encode apostrophes in HTTP(S) queries even though
  // encodeURIComponent leaves them literal. Bind the bytes sent on the wire.
  return encodeURIComponent(value).replaceAll("'", '%27');
}
