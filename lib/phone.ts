/**
 * Phone number rules shared by every form that takes one and by the API behind it, so a number the
 * form accepts is never rejected on save and both sides word a problem the same way.
 *
 * Numbers are Indian mobile numbers: ten digits starting 6, 7, 8 or 9. A +91, 91 or 0 written in
 * front is understood and dropped, because people type all three — nothing longer is accepted.
 *
 * The ten digits are what gets stored. The normalized form carries the country code as well, so two
 * spellings of the same number compare equal when looking for duplicates.
 */

export const DIAL_CODE = "91";

/** Longest string worth accepting into a phone box: "+91 98765 43210". */
export const PHONE_INPUT_MAX = 16;

export type PhoneCheck =
  | { ok: true; phone: string; phoneNormalized: string }
  | { ok: false; error: string };

export function checkPhone(raw: string): PhoneCheck {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, phone: "", phoneNormalized: "" };
  if (/[^0-9+\s()-]/.test(trimmed)) {
    return { ok: false, error: "A phone number can only contain digits, spaces, and + ( ) - characters." };
  }
  if (trimmed.slice(1).includes("+")) {
    return { ok: false, error: "Use + only at the start of the number, for the country code." };
  }

  let digits = trimmed.replace(/\D/g, "");
  // The same number gets written as 98765 43210, 098765 43210 and +91 98765 43210.
  if (digits.length === 12 && digits.startsWith(DIAL_CODE)) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);

  if (digits.length !== 10) {
    return { ok: false, error: "Enter a 10-digit Indian mobile number." };
  }
  if (!/^[6-9]/.test(digits)) {
    return { ok: false, error: "An Indian mobile number starts with 6, 7, 8, or 9." };
  }
  return { ok: true, phone: digits, phoneNormalized: `+${DIAL_CODE}${digits}` };
}

/** The message for a number that fails, or an empty string when it passes. Used by form validation. */
export function phoneError(raw: string) {
  const result = checkPhone(raw);
  return result.ok ? "" : result.error;
}
