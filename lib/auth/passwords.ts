/** Admin password rules (min length, not common, not the email). [SEC-38] */

// Small list of very common passwords and patterns (lower-cased). Extend as needed.
const COMMON = new Set([
  "password", "password1", "password123", "passw0rd", "p@ssw0rd", "p@ssword", "123456789", "1234567890", "12345678", "123123123",
  "qwerty123", "qwertyuiop", "1q2w3e4r5t", "iloveyou", "admin123", "admin@123", "administrator", "welcome1", "welcome123", "welcome@123",
  "letmein123", "football", "cricket123", "cricket@123", "sachin123", "dhoni@123", "virat@123", "india@123", "india123", "bharat123",
  "abc12345", "abcd1234", "abcd@1234", "asdfghjkl", "zxcvbnm123", "monkey123", "dragon123", "sunshine1", "princess1", "superman1",
  "turf@1234", "turf12345", "boundarybox", "boundary123", "demo@1234", "owner@1234", "staff@1234", "changeme1", "changeme123", "secret123",
]);

export const MIN_PASSWORD_LENGTH = 10;

/** Returns a reason the password is unacceptable, or null if it's fine. */
export function passwordProblem(pw: string, email: string): string | null {
  if (pw.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (pw.length > 200) return "Password is too long.";
  const lower = pw.toLowerCase();
  if (COMMON.has(lower)) return "That password is too common. Choose something harder to guess.";
  if (/^(.)\1+$/.test(pw)) return "Don't use one repeated character.";
  const local = email.toLowerCase().split("@")[0];
  if (lower === email.toLowerCase() || (local.length >= 4 && lower.includes(local))) return "Don't use your email in the password.";
  return null;
}
