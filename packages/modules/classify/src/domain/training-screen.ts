// The last check before a text goes into a training export. Redaction is best effort; when a text
// still looks like it holds an identifier, the example is dropped instead of exported.

export type ScreenReason = 'long_digit_run'

export interface ScreenResult {
  readonly keep: boolean
  /** Why the text was dropped; null when it is kept. Never the matched text itself. */
  readonly reason: ScreenReason | null
}

/**
 * Decides whether an already-redacted text may go into a training export.
 *
 * The text is dropped (`{ keep: false, reason: 'long_digit_run' }`) when it still holds a run of 8
 * or more digits, where a single space, `-` or `.` may sit between two digits, and the run is not
 * next to another digit. Such a run is most likely an identifier that redaction missed: a bank
 * account without a keyword, part of an IBAN or card, a tracking or transaction number.
 *
 * These runs are not identifiers and do not drop the text:
 * - a date: `yyyy-mm-dd`, `dd-mm-yyyy` or `dd.mm.yyyy`;
 * - an amount grouped by dots: 1 to 3 digits, then one or more `.` followed by 3 digits
 *   (`15.000.000`).
 *
 * Otherwise the text is kept: `{ keep: true, reason: null }`. Redaction tokens such as `[PHONE]`
 * hold no digits and never drop a text.
 */
export function screenForTraining(redactedText: string): ScreenResult {
  for (const [run] of redactedText.matchAll(DIGIT_RUN)) {
    if (!NOT_IDENTIFIERS.some((re) => re.test(run))) return { keep: false, reason: 'long_digit_run' }
  }
  return { keep: true, reason: null }
}

const DIGIT_RUN = /(?<!\d)\d(?:[ .-]?\d){7,}(?!\d)/g
const NOT_IDENTIFIERS = [/^\d{4}-\d{2}-\d{2}$/, /^\d{2}-\d{2}-\d{4}$/, /^\d{2}\.\d{2}\.\d{4}$/, /^\d{1,3}(?:\.\d{3})+$/]
