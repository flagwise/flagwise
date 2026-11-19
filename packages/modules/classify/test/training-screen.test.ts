import { describe, expect, it } from 'vitest'
import { redact } from '../src/domain/redact.ts'
import { screenForTraining } from '../src/domain/training-screen.ts'

const kept = { keep: true, reason: null }
const dropped = { keep: false, reason: 'long_digit_run' }

describe('screenForTraining', () => {
  it.each([
    ['a bank account without a keyword', 'transfer to 12345678 today'],
    ['a long number', 'send the money to 0012345678901'],
    ['digits split by spaces', 'pay into 1234 5678'],
    ['digits split by dashes', 'number 123-456-78'],
    ['digits split by dots', 'number 1234.5678'],
    ['what is left of a partly redacted IBAN', 'send it to DE89 3704 0044 0532 0130 00 OK'],
    ['a tracking number', 'Tracking JD014600006271842391 shows nothing'],
    ['a transaction id', 'Transaction id 8734659201 was refunded'],
    ['an identifier among other text', 'He is 34, met on 2026-11-03, account no. is 98765432'],
  ])('drops %s', (_label, text) => {
    expect(screenForTraining(text)).toEqual(dropped)
  })

  it.each([
    ['plain text', 'Fake profile, uses stolen photos of a model'],
    ['an empty text', ''],
    ['redaction tokens', 'call [PHONE] or pay [IBAN], card [CARD], account [BANK_ACCOUNT]'],
    ['an ISO date', 'We met on 2026-11-03 at 21:30'],
    ['a date with dashes', 'We met on 03-11-2026'],
    ['a date with dots', 'We met on 03.11.2026'],
    ['an ISO timestamp', 'Posted at 2026-11-03T09:12:44Z'],
    ['an amount grouped by dots', 'He said he would pay me Rp 15.000.000 by Friday'],
    ['a large amount grouped by dots', 'about 15.000.000.000 total'],
    ['an amount grouped by commas', 'He said he would pay me 2,500,000 by Friday'],
    ['7 digits', 'code 1234567'],
    ['7 separated digits', 'call 555-0132 or 123 4567'],
    ['digits split by two spaces', 'numbers 1234  5678'],
    ['digits split by other characters', 'ratio 1234/5678 and 1234_5678'],
  ])('keeps %s', (_label, text) => {
    expect(screenForTraining(text)).toEqual(kept)
  })

  it('needs 8 digits in one run', () => {
    expect(screenForTraining('id 1234567')).toEqual(kept)
    expect(screenForTraining('id 12345678')).toEqual(dropped)
    expect(screenForTraining('id 1234-567')).toEqual(kept)
    expect(screenForTraining('id 1234-5678')).toEqual(dropped)
  })

  it('treats only exact date and amount shapes as safe', () => {
    expect(screenForTraining('on 2026-11-031')).toEqual(dropped)
    expect(screenForTraining('on 2026-1103')).toEqual(dropped)
    expect(screenForTraining('amount 1.0000.000')).toEqual(dropped)
    expect(screenForTraining('amount 1234.567.890')).toEqual(dropped)
  })

  it('drops when any run is an identifier, even next to safe ones', () => {
    expect(screenForTraining('on 2026-11-03 paid Rp 2.500.000 to 12345678')).toEqual(dropped)
  })

  it('never returns the matched digits', () => {
    expect(JSON.stringify(screenForTraining('account 12345678'))).not.toContain('1234')
  })

  it('keeps a text whose identifiers redaction replaced', () => {
    const { text } = redact('card 4111 1111 1111 1111, IBAN GB82 WEST 1234 5698 7654 32, account 12345678, on 2026-11-03')
    expect(screenForTraining(text)).toEqual(kept)
  })
})
