/**
 * Turns a phone number as people type it ("+234 803 123 4567", "0803 123 4567", "00447700900123")
 * into WhatsApp's format: country code + number, digits only. Returns null if it can't be a valid number.
 * Numbers starting with a single 0 are local and need `defaultCountryCode`.
 */
export function normalizePhone(input: string, defaultCountryCode = ''): string | null {
  const trimmed = input.trim();
  let digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;

  if (trimmed.startsWith('+')) {
    // already international
  } else if (digits.startsWith('00')) {
    digits = digits.slice(2);
  } else if (digits.startsWith('0')) {
    const cc = defaultCountryCode.replace(/\D/g, '');
    if (!cc) return null;
    digits = cc + digits.slice(1);
  }

  // E.164 allows at most 15 digits; real numbers with country code have at least 8.
  return digits.length >= 8 && digits.length <= 15 && !digits.startsWith('0') ? digits : null;
}
