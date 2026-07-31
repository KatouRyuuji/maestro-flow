/** Validate user-facing Session IDs before they can become filesystem paths. */
export function validateSessionId(value: string): void {
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(value)) {
    throw new Error(`Invalid session ID: "${value}". Use lowercase alphanumeric + hyphens (e.g. 20260715-odyssey-jwt-auth).`);
  }
  if (value.length > 128) {
    throw new Error(`Session ID too long (${value.length} > 128): "${value.slice(0, 40)}..."`);
  }
}

const WINDOWS_RESERVED_BASENAME_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/** Reject non-portable filesystem path segments at the storage boundary. */
export function assertSafePathSegment(value: string, label: string): void {
  const hasWindowsReservedChars = /[<>:"|?*\x00-\x1f]/.test(value);
  const hasWindowsInvalidSuffix = /[. ]$/.test(value);
  if (!value || value === '.' || value === '..' || /[\\/]/.test(value)
    || hasWindowsReservedChars || hasWindowsInvalidSuffix
    || WINDOWS_RESERVED_BASENAME_RE.test(value)) {
    throw new Error(`Invalid ${label}: "${value}"`);
  }
}
