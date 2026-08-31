export function isBeadsIssueId(value) {
  return typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}
