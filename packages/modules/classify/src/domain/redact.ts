// Pattern-based PII redaction, for the text sent to the LLM and for training exports. The rules are
// global: international formats, checksums where a format has one, and English keywords. Names and
// street addresses need a model and are not handled here. Redaction returns a new string; the
// evidence it was made from is never changed.
//
// "Separated digits" below means digits where a single space, `-` or `.` may sit between two digits.

import { base58CheckOk, bech32Ok } from './crypto-address.ts'

export type PiiKind =
  | 'URL'
  | 'EMAIL'
  | 'PAYMENT_HANDLE'
  | 'CRYPTO'
  | 'IP'
  | 'LOCATION'
  | 'IBAN'
  | 'CARD'
  | 'BANK_ACCOUNT'
  | 'NATIONAL_ID'
  | 'PHONE'
  | 'HANDLE'

export interface Redacted {
  readonly text: string
  readonly counts: Readonly<Record<PiiKind, number>>
}

/**
 * Replaces PII with tokens, in this order, each step working on the previous step's output. Returns
 * the text and a count for every kind (0 when none were found).
 *
 * 1. URL -> [URL]: `http://`, `https://`, `hxxp://`, `hxxps://`, `ftp://` or `www.` (also written
 *    `www[.]` or `www(.)`; any case), not right after a letter or digit, up to whitespace, `<`, `>`,
 *    `"` or the end; trailing `.,!?;:)` stay outside.
 * 2. EMAIL -> [EMAIL], two passes:
 *    (a) hidden forms: a local part, an at-sign, a domain, written with any of `(at)`, `[at]`,
 *        `{at}` or ` at ` for `@`, an `@` with spaces around it, and `(dot)`, `[dot]`, `{dot}`,
 *        ` dot ` or ` . ` for `.` in the local part or the domain (any case). The local part is
 *        `A-Z a-z 0-9 _ % + -` words joined by dots; the domain is labels of `A-Z a-z 0-9 -` joined
 *        by dots, ending in 2 to 24 letters. A spelled ` at ` counts only before a known mail
 *        provider (MAIL_PROVIDERS, as the first domain label). Plain emails are left to (b).
 *    (b) one or more of `A-Z a-z 0-9 . _ % + -`, `@`, a label of `A-Z a-z 0-9 -`, then one or more
 *        `.label` parts.
 * 3. URL -> [URL]: a bare domain: labels of `A-Z a-z 0-9 -` joined by `.`, `[.]` or `(.)`, ending in
 *    a top-level domain from URL_TLDS (any case), then optionally `/`, `?` or `#` and the rest up to
 *    whitespace, `<`, `>`, `"` or the end; not right after a letter, digit, `@ . _ % + - / :`, not
 *    followed by a letter, digit, `-` or `@`; trailing `.,!?;:)` stay outside.
 * 4. PAYMENT_HANDLE -> [PAYMENT_HANDLE]: (a) a UPI id: 2 to 64 of `A-Z a-z 0-9 . _ -`, `@`, then a
 *    payment provider from UPI_PROVIDERS (any case), not right after a letter, digit, `.` or `-`,
 *    and not followed by a letter, digit, `-`, or `.` and a letter or digit;
 *    (b) a cashtag: `$`, a letter, then 1 to 19 of `A-Z a-z 0-9 _`, not right after a letter, digit
 *    or `$` and not followed by a letter, digit or `_`; 2 to 5 uppercase letters alone are a ticker
 *    (`$BTC`), not a cashtag.
 * 5. CRYPTO -> [CRYPTO], not next to a letter or digit: (a) Base58Check addresses: `1` or `3`
 *    (Bitcoin), `T` (Tron), `L` or `M` (Litecoin) or `D` (Dogecoin), then Base58 characters, 26 to
 *    35 in total, whose checksum and version byte match; (b) Bech32 / Bech32m addresses starting
 *    with `bc1`, `tb1` or `ltc1` (any case) with a valid checksum; (c) `0x` then 40 hex digits (an
 *    EVM address) or 64 (a transaction hash).
 * 6. IP -> [IP]: (a) IPv4: four numbers from 0 to 255 joined by `.`, not right after a letter, digit
 *    or `.` and not followed by a digit or by `.` and a digit; (b) IPv6: 3 to 8 groups of 1 to 4 hex
 *    digits joined by `:`, with at most one `::`, exactly 8 groups when there is no `::`, at least
 *    one group of 3 or more characters, and not 6 groups of 2 (a MAC address); not next to a
 *    letter, digit or `:`.
 * 7. LOCATION -> [LOCATION]: a latitude and a longitude: `-`? 1 to 2 digits, `.`, 4 or more digits,
 *    optional `°` and `N`/`S`, a comma, then `-`? 1 to 3 digits, `.`, 4 or more digits, optional `°`
 *    and `E`/`W`; latitude at most 90 and longitude at most 180; and either both have 5 or more
 *    decimals, or the longitude is above 90, or a `°`, `N`, `S`, `E` or `W` is given. Not next to a
 *    digit or `.` followed by a digit.
 * 8. IBAN -> [IBAN]: two letters and two digits, not right after a letter or digit, then letters and
 *    digits with single spaces allowed between them; letters in any case. The IBAN is the first N
 *    of those characters (spaces not counted), where N is the IBAN length of the country named by
 *    the first two letters (IBAN_LENGTHS); for a country not in the table, the longest N from 34
 *    down to 15 that qualifies. It qualifies when the character right after it is not a letter or
 *    digit and it passes ISO 13616 (uppercase it, move the first four characters to the end,
 *    letters to numbers A = 10 ... Z = 35, mod 97 = 1). Whatever follows the IBAN stays.
 * 9. CARD -> [CARD]: a run of digits with single spaces or `-` allowed between them, not right after
 *    a letter or digit. The whole run is a card when it has 13 to 19 digits, is not followed by a
 *    letter or digit, and passes the Luhn check. Otherwise its first 19, 16, 15 or 14 digits (tried
 *    in that order) are a card when they end right before a space or `-` and pass the Luhn check;
 *    the rest of the run stays. No card starts inside a run.
 * 10. BANK_ACCOUNT -> [BANK_ACCOUNT]: a whole-word keyword (any case: account, acct, acc, a/c, bank,
 *    routing), at most 20 non-digit characters, then 6 to 17 separated digits not followed by a
 *    digit. Only the number is replaced.
 * 11. NATIONAL_ID -> [NATIONAL_ID], three passes:
 *    (a) the US SSN form `ddd-dd-dddd` with no digit around it;
 *    (b) ID shapes with a check, uppercase, not next to a letter or digit: Singapore NRIC / FIN
 *        (`S`, `T`, `F` or `G`, 7 digits, a check letter), Spain DNI (8 digits and a check letter)
 *        and NIE (`X`, `Y` or `Z`, 7 digits, a check letter, both mod 23), Italy codice fiscale
 *        (16 characters with its check letter), Mexico CURP (18 characters with its check digit),
 *        and the UK National Insurance number (two prefix letters allowed by HMRC, 6 digits, `A` to
 *        `D`; single spaces allowed between the parts; it has no check);
 *    (c) a whole-word keyword from ID_KEYWORDS (any case), at most 20 non-digit characters, then an
 *        ID: uppercase letters and digits, where a single space, `-` or `.` may also sit between two
 *        digits; 6 to 20 letters and digits in total, at least 4 of them digits; not next to a
 *        letter or digit. Only the ID is replaced.
 * 12. PHONE -> [PHONE], not right after a letter, digit, `_` or `+` and not followed by a letter,
 *    digit or `_`: (a) `+` then 8 to 15 separated digits; (b) 10 to 15 separated digits starting
 *    with `0`; (c) the North American form: 3 digits (optionally in parentheses), a space, `-` or
 *    `.`, 3 digits, a space, `-` or `.`, 4 digits.
 * 13. HANDLE -> [HANDLE]: `@` then 1 to 30 of `A-Z a-z 0-9 _ .`, starting and ending with a letter,
 *    digit or `_`; not right after a letter, digit, `_`, `@` or `.`, and not followed by a letter,
 *    digit or `_`.
 * 14. Hidden digits. A run written to dodge the rules above is decoded, and replaced with
 *    [PHONE] or [CARD] when the decoded run as a whole is one (steps 9 and 12 on that run alone);
 *    otherwise it stays as written. The runs, not next to a letter or digit:
 *    (a) digits of any script (full-width, Arabic-Indic, Devanagari, ...) and keycap emoji (a digit,
 *        an optional U+FE0F, U+20E3), with single spaces, `-` or `.` between them, holding at least
 *        one that is not a plain ASCII digit; each becomes its ASCII digit;
 *    (b) English digit words (`zero`, `oh`, `o`, `one` ... `nine`, any case; `double` or `triple`
 *        before one repeats it) and ASCII digit groups, separated by 1 or 2 of space, `,`, `.` or `-`,
 *        holding at least one word and 7 or more digits once decoded;
 *    (c) ASCII digits mixed with the lookalike letters `O`, `o` (for 0), `I`, `l` (for 1), with
 *        single spaces, `-` or `.` between them, holding at least one lookalike and 6 or more digits.
 * 15. HANDLE -> [HANDLE]: a contact after a messaging app's name. A whole-word app name from
 *    CONTACT_APPS (any case), then either an explicit separator (`:`, `=` or `-`, or the word `id`,
 *    `username`, `handle` or `name` with an optional `:`, `=`, `-` or `is` after it) and a username,
 *    or a space or ` is ` and a username that holds a digit, `_` or `.`. The username is an optional
 *    `@`, then 3 to 30 of `A-Z a-z 0-9 _ .` starting with a letter, digit or `_`, not followed by a
 *    letter, digit or `_`. Only the username is replaced.
 */
export function redact(text: string): Redacted {
  const counts: Record<PiiKind, number> = {
    URL: 0,
    EMAIL: 0,
    PAYMENT_HANDLE: 0,
    CRYPTO: 0,
    IP: 0,
    LOCATION: 0,
    IBAN: 0,
    CARD: 0,
    BANK_ACCOUNT: 0,
    NATIONAL_ID: 0,
    PHONE: 0,
    HANDLE: 0,
  }
  // Applies a replacer to every match; a replacer returns the new text, or null to keep the match.
  const apply = (input: string, kind: PiiKind, re: RegExp, replacer: (...groups: string[]) => string | null): string =>
    input.replace(re, (...args: unknown[]) => {
      const groups = args.slice(0, args.findIndex((a) => typeof a === 'number')).map((g) => (g ?? '') as string)
      const out = replacer(...groups)
      if (out === null) return groups[0]!
      counts[kind]++
      return out
    })
  const keepTrailing = (token: string) => (match: string) => `${token}${/[.,!?;:)]*$/.exec(match)![0]}`

  let out = text

  out = apply(out, 'URL', /(?<![A-Za-z0-9])(?:(?:https?|hxxps?|ftp):\/\/|www(?:\.|\[\.\]|\(\.\)))[^\s<>"]*/gi, keepTrailing('[URL]'))

  out = apply(out, 'EMAIL', HIDDEN_EMAIL, (match, _local, at, domain) => {
    const plain = at === '@' && !/[\s([{]/.test(match)
    if (plain) return null
    if (/^\s+at\s+$/i.test(at!) && !MAIL_PROVIDERS.has(domain!.split(DOT_SPLIT)[0]!.toLowerCase())) return null
    return '[EMAIL]'
  })
  out = apply(out, 'EMAIL', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, () => '[EMAIL]')

  out = apply(out, 'URL', BARE_DOMAIN, keepTrailing('[URL]'))

  out = apply(out, 'PAYMENT_HANDLE', UPI_ID, () => '[PAYMENT_HANDLE]')
  out = apply(out, 'PAYMENT_HANDLE', /(?<![A-Za-z0-9$])\$(?![A-Z]{2,5}(?![A-Za-z0-9_]))[A-Za-z][A-Za-z0-9_]{1,19}(?![A-Za-z0-9_])/g, () => '[PAYMENT_HANDLE]')

  out = apply(out, 'CRYPTO', /(?<![A-Za-z0-9])[13TLMD][1-9A-HJ-NP-Za-km-z]{25,34}(?![A-Za-z0-9])/g, (m) =>
    base58CheckOk(m, BASE58_VERSIONS[m[0]!]!) ? '[CRYPTO]' : null,
  )
  out = apply(out, 'CRYPTO', /(?<![A-Za-z0-9])(?:bc|tb|ltc)1[A-Za-z0-9]{6,87}(?![A-Za-z0-9])/gi, (m) => (bech32Ok(m) ? '[CRYPTO]' : null))
  out = apply(out, 'CRYPTO', /(?<![A-Za-z0-9])0x(?:[0-9a-fA-F]{64}|[0-9a-fA-F]{40})(?![A-Za-z0-9])/g, () => '[CRYPTO]')

  out = apply(out, 'IP', /(?<![A-Za-z0-9.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?!\d|\.\d)/g, () => '[IP]')
  out = apply(out, 'IP', /(?<![A-Za-z0-9:])[0-9A-Fa-f:]{6,39}(?![A-Za-z0-9:])/g, (m) => (ipv6Ok(m) ? '[IP]' : null))

  out = apply(out, 'LOCATION', COORDINATES, (_m, lat, latDec, latMark, lon, lonDec, lonMark) =>
    Math.abs(Number(lat)) <= 90 &&
    Math.abs(Number(lon)) <= 180 &&
    ((latDec!.length >= 5 && lonDec!.length >= 5) || Math.abs(Number(lon)) > 90 || /[°NSEW]/.test(latMark! + lonMark!))
      ? '[LOCATION]'
      : null,
  )

  out = replaceIbans(out, () => counts.IBAN++)
  out = replaceCards(out, () => counts.CARD++)

  out = apply(
    out,
    'BANK_ACCOUNT',
    /(?<![A-Za-z0-9])((?:account|acct|acc|a\/c|bank|routing)(?![A-Za-z0-9])\D{0,20}?)(\d(?:[ .-]?\d){5,16})(?!\d)/gi,
    (_match, prefix) => `${prefix}[BANK_ACCOUNT]`,
  )

  out = apply(out, 'NATIONAL_ID', /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g, () => '[NATIONAL_ID]')
  for (const [re, ok] of ID_SHAPES) out = apply(out, 'NATIONAL_ID', re, (m) => (ok(m.replace(/ /g, '')) ? '[NATIONAL_ID]' : null))
  out = apply(out, 'NATIONAL_ID', ID_AFTER_KEYWORD, (_match, keyword, gap, id) => {
    const compact = id!.replace(/[ .-]/g, '')
    return compact.length <= 20 && compact.length >= 6 && (compact.match(/\d/g)?.length ?? 0) >= 4 ? `${keyword}${gap}[NATIONAL_ID]` : null
  })

  out = apply(out, 'PHONE', PHONE, () => '[PHONE]')

  out = apply(out, 'HANDLE', /(?<![A-Za-z0-9_@.])@[A-Za-z0-9_](?:[A-Za-z0-9_.]{0,28}[A-Za-z0-9_])?(?![A-Za-z0-9_])/g, () => '[HANDLE]')
  out = replaceHiddenDigits(out, (kind) => counts[kind]++)

  out = apply(out, 'HANDLE', CONTACT, (_m, app, sep) => `${app}${sep}[HANDLE]`)

  return { text: out, counts }
}

/** First domain labels of mail providers, for emails written with a spelled ` at `. */
export const MAIL_PROVIDERS: ReadonlySet<string> = new Set(
  ('gmail googlemail yahoo ymail rocketmail outlook hotmail live msn icloud me mac aol proton protonmail pm gmx web ' +
    'mail yandex zoho qq 163 126 sina naver daum hanmail tutanota tuta fastmail rediffmail libero orange free laposte ' +
    'seznam wp onet interia rambler bk inbox list t-online freenet btinternet sky virgin comcast verizon att sbcglobal')
    .split(' '),
)

/** Top-level domains a bare domain may end in. */
export const URL_TLDS: readonly string[] = (
  'com net org info biz io co app dev me xyz top online site shop store live club link click win vip icu buzz ' +
  'tv cc ly gl gg ai ws fun life world today page website space tech cloud pro one wiki blog news ' +
  'uk de fr nl be es it pt ch at ie se no fi dk pl cz ru ua tr gr ro hu eu us ca mx br ar cl pe ' +
  'au nz jp kr cn hk tw sg my id ph th vn in pk bd lk ng ke za eg ae sa'
).split(' ')

/** Words that introduce a national ID, tax ID, passport or licence number: English and widely used local terms. */
export const ID_KEYWORDS: readonly string[] = [
  'passport', 'ssn', 'national id', 'id number', 'id no', 'identity number', 'identity card',
  "driver's license", 'drivers license', 'driver license', "driver's licence", 'driving licence', 'licence', 'license',
  'tax id', 'tin', 'ni number', 'national insurance', 'nik', 'ktp', 'npwp', 'aadhaar', 'aadhar', 'pan', 'cpf', 'rg',
  'dni', 'nie', 'nif', 'nric', 'fin', 'curp', 'rfc', 'codice fiscale', 'sin', 'tfn', 'mykad', 'ic', 'nin', 'rrn',
  'my number',
]

/** UPI payment service provider handles (the part after `@`). */
export const UPI_PROVIDERS: readonly string[] = (
  'upi ybl ibl axl paytm apl okaxis okhdfcbank okicici oksbi icici sbi hdfcbank axisbank kotak pthdfc ptsbi ptaxis ' +
  'ptyes yesbank airtel freecharge jio waaxis wahdfcbank wasbi waicici idfcbank indus barodampay rbl aubank federal ' +
  'kmbl pnb boi cnrb unionbank dbs'
).split(' ')

/** Messaging apps whose name may introduce a contact. */
export const CONTACT_APPS: readonly string[] = (
  'ig insta instagram snap snapchat sc telegram tele tg line wechat weixin wx kik discord tiktok twitter threads ' +
  'fb facebook skype signal viber whatsapp wa'
).split(' ')

const ID_AFTER_KEYWORD = new RegExp(
  `(?<![A-Za-z0-9])(${ID_KEYWORDS.map(anyCase).join('|')})(?![A-Za-z0-9])(\\D{0,20}?)(?<![A-Za-z0-9])` +
    String.raw`([A-Z0-9](?:[A-Z0-9]|(?<=\d)[ .\-](?=\d))*)(?![A-Za-z0-9])`,
  'g',
)

const DNI_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE'
const CF_ODD = [1, 0, 5, 7, 9, 13, 15, 17, 19, 21, 2, 4, 18, 20, 11, 3, 6, 8, 12, 14, 16, 10, 22, 25, 24, 23]
const CURP_CHARS = '0123456789ABCDEFGHIJKLMNÑOPQRSTUVWXYZ'
const ID_SHAPES: readonly [RegExp, (id: string) => boolean][] = [
  [
    /(?<![A-Za-z0-9])[STFG]\d{7}[A-Z](?![A-Za-z0-9])/g,
    (id) => {
      const weights = [2, 7, 6, 5, 4, 3, 2]
      const sum = [...id.slice(1, 8)].reduce((a, d, i) => a + Number(d) * weights[i]!, 0) + ('TG'.includes(id[0]!) ? 4 : 0)
      return ('ST'.includes(id[0]!) ? 'JZIHGFEDCBA' : 'XWUTRQPNMLK')[sum % 11] === id[8]
    },
  ],
  [
    /(?<![A-Za-z0-9])(?:\d{8}|[XYZ]\d{7})[A-Z](?![A-Za-z0-9])/g,
    (id) => DNI_LETTERS[Number(id.slice(0, 8).replace(/^[XYZ]/, (c) => String('XYZ'.indexOf(c)))) % 23] === id[8],
  ],
  [
    /(?<![A-Za-z0-9])[A-Z]{6}\d{2}[ABCDEHLMPRST]\d{2}[A-Z]\d{3}[A-Z](?![A-Za-z0-9])/g,
    (id) => {
      let sum = 0
      for (let i = 0; i < 15; i++) {
        const c = id[i]!
        // A digit counts as the letter at the same index (0 as A, 1 as B, ...) in both tables.
        const n = /\d/.test(c) ? Number(c) : c.charCodeAt(0) - 65
        sum += i % 2 === 0 ? CF_ODD[n]! : n
      }
      return String.fromCharCode(65 + (sum % 26)) === id[15]
    },
  ],
  [
    /(?<![A-Za-z0-9])[A-Z]{4}\d{6}[HMX][A-Z]{5}[A-Z0-9]\d(?![A-Za-z0-9])/g,
    (id) => {
      let sum = 0
      for (let i = 0; i < 17; i++) sum += CURP_CHARS.indexOf(id[i]!) * (18 - i)
      return String((10 - (sum % 10)) % 10) === id[17]
    },
  ],
  [
    /(?<![A-Za-z0-9])(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D](?![A-Za-z0-9])/g,
    () => true,
  ],
]

const BASE58_VERSIONS: Record<string, number> = { '1': 0x00, '3': 0x05, T: 0x41, L: 0x30, M: 0x32, D: 0x1e }

const DOT_WORD = String.raw`\s*[([{]dot[)\]}]\s*|\s+dot\s+`
const DOT = String.raw`(?:\.|\s\.\s|${DOT_WORD})`
const DOT_SPLIT = new RegExp(DOT, 'i')
const HIDDEN_EMAIL = new RegExp(
  String.raw`(?<![A-Za-z0-9._%+-])([A-Za-z0-9_%+-]+(?:${DOT}[A-Za-z0-9_%+-]+)*)(\s*@\s*|\s*[([{]at[)\]}]\s*|\s+at\s+)([A-Za-z0-9-]+(?:${DOT}[A-Za-z0-9-]+)*${DOT}[A-Za-z]{2,24})(?![A-Za-z0-9-])`,
  'gi',
)
const BARE_DOMAIN = new RegExp(
  String.raw`(?<![A-Za-z0-9@._%+\-/:])(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.|\[\.\]|\(\.\)))+(?:${URL_TLDS.join('|')})(?![A-Za-z0-9\-@])(?:[/?#][^\s<>"]*)?`,
  'gi',
)
const UPI_ID = new RegExp(
  String.raw`(?<![A-Za-z0-9.\-])[A-Za-z0-9._\-]{2,64}@(?:${UPI_PROVIDERS.join('|')})(?![A-Za-z0-9\-]|\.[A-Za-z0-9])`,
  'gi',
)
const COORDINATES = /(?<![\d.])(-?\d{1,2}\.(\d{4,}))(°?(?:\s*[NS])?)\s*,\s*(-?\d{1,3}\.(\d{4,}))(°?(?:\s*[EW])?)(?!\d|\.\d)/g
const PHONE =
  /(?<![A-Za-z0-9_+])(?:\+\d(?:[ .-]?\d){7,14}|0(?:[ .-]?\d){9,14}|(?:\(\d{3}\)|\d{3})[ .-]\d{3}[ .-]\d{4})(?![A-Za-z0-9_])/g
const CONTACT = new RegExp(
  String.raw`(?<![A-Za-z0-9])(${CONTACT_APPS.join('|')})(?![A-Za-z0-9])` +
    String.raw`(\s*(?:id|username|handle|name)(?:\s*(?:[:=\-]|is))?\s*|\s*[:=\-]\s*|(?:\s+is)?\s+(?=@?[A-Za-z0-9_.]*[0-9_.]))` +
    String.raw`@?[A-Za-z0-9_][A-Za-z0-9_.]{2,29}(?![A-Za-z0-9_])`,
  'gi',
)

function ipv6Ok(token: string): boolean {
  const groups = token.split(':')
  if (groups.length < 3 || groups.length > 8 || groups.some((g) => g.length > 4)) return false
  const doubles = token.match(/::/g)?.length ?? 0
  if (doubles > 1 || (doubles === 0 && groups.length !== 8)) return false
  if (groups.length === 6 && groups.every((g) => g.length === 2)) return false
  return groups.some((g) => g.length >= 3)
}

const DIGIT_WORDS: Record<string, string> = {
  zero: '0', oh: '0', o: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
}
const DIGIT_WORD = String.raw`(?:(?:double|triple)\s+)?(?:zero|oh|o|one|two|three|four|five|six|seven|eight|nine)`
const HIDDEN_RUNS: readonly [RegExp, (run: string) => string | null][] = [
  // (a) digits of any script and keycap emoji
  [
    /(?<![\p{L}\p{N}])(?:\p{Nd}️?⃣?)(?:[ .-]?\p{Nd}️?⃣?)*(?![\p{L}\p{N}])/gu,
    (run) => (/[^\x00-\x7F]/.test(run) ? run.replace(/[️⃣]/g, '').replace(/\p{Nd}/gu, asciiDigit) : null),
  ],
  // (b) digit words, alone or mixed with digit groups
  [
    new RegExp(String.raw`(?<![A-Za-z0-9])(?:${DIGIT_WORD}|\d+)(?:[\s,.\-]{1,2}(?:${DIGIT_WORD}|\d+))+(?![A-Za-z0-9])`, 'gi'),
    (run) => {
      if (!/[a-z]/i.test(run)) return null
      const tokens = run.toLowerCase().split(/[\s,.\-]+/).filter(Boolean)
      let digits = ''
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i]!
        if (t === 'double' || t === 'triple') digits += DIGIT_WORDS[tokens[++i]!]!.repeat(t === 'double' ? 2 : 3)
        else digits += DIGIT_WORDS[t] ?? t
      }
      return digits.length >= 7 ? digits : null
    },
  ],
  // (c) lookalike letters among digits
  [
    /(?<![A-Za-z0-9])[0-9OoIl](?:[ .-]?[0-9OoIl])*(?![A-Za-z0-9])/g,
    (run) => (/[OoIl]/.test(run) && (run.match(/\d/g)?.length ?? 0) >= 6 ? run.replace(/[Oo]/g, '0').replace(/[Il]/g, '1') : null),
  ],
]

function replaceHiddenDigits(text: string, count: (kind: 'PHONE' | 'CARD') => void): string {
  let out = text
  for (const [re, decode] of HIDDEN_RUNS) {
    out = out.replace(re, (run) => {
      const decoded = decode(run)
      if (decoded === null) return run
      if (new RegExp(`^(?:${PHONE.source})$`).test(decoded)) {
        count('PHONE')
        return '[PHONE]'
      }
      if (replaceCards(decoded, () => {}) === '[CARD]') {
        count('CARD')
        return '[CARD]'
      }
      return run
    })
  }
  return out
}

/** The ASCII digit of a decimal digit of any script (digits of a script are 10 code points in a row). */
function asciiDigit(c: string): string {
  if (c >= '0' && c <= '9') return c
  let cp = c.codePointAt(0)!
  let value = 0
  while (value < 9 && /\p{Nd}/u.test(String.fromCodePoint(cp - 1))) {
    cp--
    value++
  }
  return String(value)
}

function anyCase(word: string): string {
  return word.replace(/[a-z]/g, (c) => `[${c}${c.toUpperCase()}]`)
}

function luhnOk(digits: string): boolean {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

/** IBAN length per country code, from the ISO 13616 registry. */
export const IBAN_LENGTHS: Readonly<Record<string, number>> = Object.fromEntries(
  (
    'AD24 AE23 AL28 AT20 AZ28 BA20 BE16 BG22 BH22 BI27 BR29 BY28 CH21 CR22 CY28 CZ24 DE22 DJ27 DK18 DO28 EE20 EG29 ' +
    'ES24 FI18 FK18 FO18 FR27 GB22 GE22 GI23 GL18 GR27 GT28 HR21 HU28 IE22 IL23 IQ23 IS26 IT27 JO30 KW30 KZ20 LB28 ' +
    'LC32 LI21 LT20 LU20 LV21 LY25 MC27 MD24 ME22 MK19 MN20 MR27 MT31 MU30 NI28 NL18 NO15 OM23 PK24 PL28 PS29 PT25 ' +
    'QA29 RO24 RS22 RU33 SA24 SC31 SD18 SE24 SI19 SK24 SM27 SO23 ST25 SV28 TL23 TN24 TR26 UA29 VA22 VG24 XK20 YE30'
  )
    .split(' ')
    .map((entry) => [entry.slice(0, 2), Number(entry.slice(2))]),
)

const isAlnum = (c: string | undefined) => c !== undefined && /[A-Za-z0-9]/.test(c)

/**
 * Reads a run of `char` characters from `start`, where one `sep` may sit between two of them.
 * Returns, for each character of the run, the offset right after it.
 */
function scanRun(text: string, start: number, char: RegExp, sep: RegExp): number[] {
  const ends: number[] = []
  let i = start
  while (i < text.length) {
    if (char.test(text[i]!)) ends.push(++i)
    else if (ends.length > 0 && sep.test(text[i]!) && char.test(text[i + 1] ?? '')) i++
    else break
  }
  return ends
}

function replaceIbans(text: string, count: () => void): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    if (!isAlnum(text[i - 1]) && /^[A-Za-z]{2}\d{2}/.test(text.slice(i, i + 4))) {
      const ends = scanRun(text, i, /[A-Za-z0-9]/, / /)
      const known = IBAN_LENGTHS[text.slice(i, i + 2).toUpperCase()]
      const lengths = known ? [known] : Array.from({ length: 20 }, (_, k) => 34 - k)
      const n = lengths.find(
        (len) =>
          len <= ends.length &&
          !isAlnum(text[ends[len - 1]!]) &&
          ibanChecksumOk(text.slice(i, ends[len - 1]).replace(/ /g, '').toUpperCase()),
      )
      if (n !== undefined) {
        out += '[IBAN]'
        count()
        i = ends[n - 1]!
        continue
      }
    }
    out += text[i]
    i++
  }
  return out
}

function replaceCards(text: string, count: () => void): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    if (/\d/.test(text[i]!) && !isAlnum(text[i - 1])) {
      const ends = scanRun(text, i, /\d/, /[ -]/)
      const digits = (len: number) => text.slice(i, ends[len - 1]).replace(/[ -]/g, '')
      const whole = ends.length
      let n: number | undefined
      if (whole >= 13 && whole <= 19 && !isAlnum(text[ends[whole - 1]!]) && luhnOk(digits(whole))) n = whole
      else n = [19, 16, 15, 14].find((len) => len < whole && /[ -]/.test(text[ends[len - 1]!]!) && luhnOk(digits(len)))
      if (n !== undefined) {
        out += '[CARD]'
        count()
        i = ends[n - 1]!
        continue
      }
      out += text.slice(i, ends[whole - 1])
      i = ends[whole - 1]!
      continue
    }
    out += text[i]
    i++
  }
  return out
}

function ibanChecksumOk(iban: string): boolean {
  const rearranged = iban.slice(4) + iban.slice(0, 4)
  let remainder = 0
  for (const ch of rearranged) {
    const value = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97
  }
  return remainder === 1
}
