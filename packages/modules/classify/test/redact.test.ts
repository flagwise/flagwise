// Card numbers are the standard test numbers; IBANs are the published examples, except the
// DE51 and ZZ72 vectors, built for these tests. Crypto addresses are the published examples
// (genesis block, BIP173, BIP350, the Tron USDT contract), except the Litecoin and Dogecoin ones,
// built for these tests. Checksums were verified independently in Python.
import { describe, expect, it } from 'vitest'
import { IBAN_LENGTHS, redact, type PiiKind } from '../src/domain/redact.ts'

const zero: Record<PiiKind, number> = {
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
const text = (s: string) => redact(s).text

describe('URL', () => {
  it.each([
    ['check https://bit.ly/abc123?x=1, cheap!', 'check [URL], cheap!'],
    ['play at www.casino88.example.', 'play at [URL].'],
    ['HTTP://Example.COM/promo', '[URL]'],
    ['link (https://x.co/a)', 'link ([URL])'],
    ['two links: http://a.io and https://b.io/x?y', 'two links: [URL] and [URL]'],
    ['<https://x.co/a>"', '<[URL]>"'],
  ])('%j', (input, expected) => {
    expect(text(input)).toBe(expected)
  })

  it('does not start right after a letter or digit', () => {
    expect(text('xhttps://a.io')).toBe('xhttps://a.io')
    expect(text('awww.example')).toBe('awww.example')
  })

  it('swallows an email inside a URL', () => {
    expect(redact('https://x.com/u/jane@b.co')).toEqual({ text: '[URL]', counts: { ...zero, URL: 1 } })
  })

  it.each([
    ['hxxps://dating-verify[.]top/id?u=8812', '[URL]'],
    ['open hxxp://x.co/a now', 'open [URL] now'],
    ['link: www[.]free-iphone-giveaway[.]win', 'link: [URL]'],
    ['www(.)casino88.example', '[URL]'],
    ['ftp://files.example/x', '[URL]'],
  ])('finds a disguised link: %j', (input, expected) => {
    expect(text(input)).toBe(expected)
  })

  it.each([
    ['Here is my linkedin linkedin.com/in/jane-doe-4b21a7190', 'Here is my linkedin [URL]'],
    ['her site janedoemodels.wixsite.com/home!', 'her site [URL]!'],
    ['pay on paypal.me/JaneDoe99.', 'pay on [URL].'],
    ['see example[.]com', 'see [URL]'],
    ['Open metamask-wallet-sync.app/connect', 'Open [URL]'],
    ['shop at tokopedia.co.id today', 'shop at [URL] today'],
    ['go to BIT.LY/2kFr9Xy', 'go to [URL]'],
  ])('finds a bare domain: %j', (input, expected) => {
    expect(text(input)).toBe(expected)
  })

  it.each([
    ['a TLD that is not listed', 'Node.js and file.txt and report.pdf'],
    ['an abbreviation', 'e.g. this, i.e. that'],
    ['a domain inside an email', 'jane@example.com'.replace('example.com', 'localhost')],
    ['right after a letter', 'xexample.com'.replace('.com', '.comx')],
    ['followed by @', 'jane.co@'],
  ])('leaves %s alone', (_label, input) => {
    expect(text(input)).toBe(input)
  })

  it('does not take a domain right after / or :', () => {
    expect(text('a//b.io and c:d.io')).toBe('a//b.io and c:d.io')
  })
})

describe('EMAIL', () => {
  it.each([
    ['contact me at jane.doe@gmail.com ok', 'contact me at [EMAIL] ok'],
    ['email: John_Doe+promo@mail.co.uk.', 'email: [EMAIL].'],
    ['a@b.c and c-d@e-f.org', '[EMAIL] and [EMAIL]'],
  ])('%j', (input, expected) => {
    expect(text(input)).toBe(expected)
  })

  it('needs a dot in the domain', () => {
    expect(text('jane@localhost')).toBe('jane@localhost')
  })

  it.each([
    ['email jane dot doe at gmail dot com', 'email [EMAIL]'],
    ['mail jane.doe(at)gmail.com', 'mail [EMAIL]'],
    ['jane.doe [at] yahoo [dot] com', '[EMAIL]'],
    ['jane.doe {AT} outlook {DOT} com.', '[EMAIL].'],
    ['contact jane.doe @ gmail.com ok', 'contact [EMAIL] ok'],
    ['write to jane.doe @ outlook . com', 'write to [EMAIL]'],
    ['email jdoe85 at gmail.com.', 'email [EMAIL].'],
  ])('finds a hidden email: %j', (input, expected) => {
    expect(text(input)).toBe(expected)
  })

  it.each([
    ['a spelled at before a domain that is not a mail provider', 'I work at acme dot com'],
    ['a spelled at in a sentence', 'meet at the mall at 7'],
    ['a sentence after an email without a domain', 'mail me jane@gmail. Then go'],
    ['a dot with a space on one side only', 'jane (at) gmail. com'],
  ])('leaves %s alone', (_label, input) => {
    expect(text(input)).toBe(input)
  })

  it('counts a hidden email once', () => {
    expect(redact('jane dot doe at gmail dot com').counts).toEqual({ ...zero, EMAIL: 1 })
  })
})

describe('PAYMENT_HANDLE', () => {
  it.each([
    ['pay 9876543120@paytm now', 'pay [PAYMENT_HANDLE] now'],
    ['UPI jane.doe@okaxis.', 'UPI [PAYMENT_HANDLE].'],
    ['send to JANE-DOE@YBL', 'send to [PAYMENT_HANDLE]'],
    ['cash app $JaneDoe99', 'cash app [PAYMENT_HANDLE]'],
    ['send to $john_doe first', 'send to [PAYMENT_HANDLE] first'],
    ['$Jd', '[PAYMENT_HANDLE]'],
  ])('%j', (input, expected) => {
    expect(text(input)).toBe(expected)
  })

  it.each([
    ['a ticker', 'buy $BTC and $USDT now'],
    ['an amount', 'pay $45 or $1,299'],
    ['a provider that is not listed', 'jane@paytmx'],
    ['a dollar after a letter', 'US$JaneDoe'],
  ])('leaves %s alone', (_label, input) => {
    expect(text(input)).toBe(input)
  })

  it('leaves a provider followed by a domain to the email rule', () => {
    expect(redact('jane@paytm.example').counts).toEqual({ ...zero, EMAIL: 1 })
  })
})

describe('CRYPTO', () => {
  it.each([
    ['Bitcoin legacy', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'],
    ['Bitcoin P2SH', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'],
    ['Bitcoin SegWit', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'],
    ['Bitcoin SegWit, uppercase', 'BC1QAR0SRRR7XFKVY5L643LYDNW9RE59GTZZWF5MDQ'],
    ['Bitcoin Taproot', 'bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297'],
    ['Tron', 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7'],
    ['Litecoin L', 'LKKHMBjCU89fyFNgSRprDoD8Jb25N8uWvd'],
    ['Litecoin M', 'M7zVKQKmtV5Rc7erVGVVC3khZbXxsS5HEX'],
    ['Dogecoin', 'D5ERdEN1gsouFSs7zsq7VYJxyWP6dP28H1'],
    ['an EVM address', '0x742d35Cc6634C0532925a3b844Bc454e4438f44e'],
    ['a transaction hash', `0x${'ab'.repeat(32)}`],
  ])('finds %s', (_label, address) => {
    expect(redact(`send USDT to ${address}.`)).toEqual({ text: 'send USDT to [CRYPTO].', counts: { ...zero, CRYPTO: 1 } })
  })

  it.each([
    ['a Base58 checksum that fails', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb'],
    ['a Bech32 checksum that fails', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdr'],
    ['mixed case Bech32', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdQ'],
    ['a version byte that does not match its first character', 'D5ERdEN1gsouFSs7zsq7VYJxyWP6dP28H1'.replace(/^D/, '1')],
    ['hex of another length', `0x${'a'.repeat(39)}`],
    ['an address glued to a word', 'x1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'],
  ])('leaves %s alone', (_label, input) => {
    expect(redact(input).counts.CRYPTO).toBe(0)
  })
})

describe('IP', () => {
  it.each([
    ['his ip 192.168.1.10.', 'his ip [IP].'],
    ['from 8.8.8.8 and 255.255.255.255', 'from [IP] and [IP]'],
    ['ip 2001:db8:85a3::8a2e:370:7334', 'ip [IP]'],
    ['full 2001:0db8:85a3:0000:0000:8a2e:0370:7334', 'full [IP]'],
  ])('%j', (input, expected) => {
    expect(text(input)).toBe(expected)
  })

  it.each([
    ['a number above 255', 'build 10.0.19045'],
    ['five parts', 'version 1.2.3.4.5'],
    ['a MAC address', 'mac aa:bb:cc:dd:ee:ff'],
    ['a time', 'at 12:30:45'],
    ['a C++ scope', 'std::vector'],
    ['two double colons', '2001::db8::1'],
  ])('leaves %s alone', (_label, input) => {
    expect(redact(input).counts.IP).toBe(0)
  })
})

describe('LOCATION', () => {
  it.each([
    ['come to -6.20881, 106.84562 now', 'come to [LOCATION] now'],
    ['NYC 40.712776, -74.005974.', 'NYC [LOCATION].'],
    ['Jakarta -6.2088,106.8456', 'Jakarta [LOCATION]'],
    ['at 51.50735° N, 0.12776° W', 'at [LOCATION]'],
  ])('%j', (input, expected) => {
    expect(text(input)).toBe(expected)
  })

  it.each([
    ['prices with 4 decimals', 'prices 1.2500, 3.5000'],
    ['a latitude above 90', 'scores 91.12345, 10.12345'],
    ['a longitude above 180', 'x 10.12345, 181.12345'],
    ['too few decimals', 'rate 6.208, 106.845'],
  ])('leaves %s alone', (_label, input) => {
    expect(text(input)).toBe(input)
  })
})

describe('IBAN', () => {
  it.each([
    ['pay to GB82 WEST 1234 5698 7654 32 today', 'pay to [IBAN] today'],
    ['IBAN: DE89370400440532013000.', 'IBAN: [IBAN].'],
    ['NL91ABNA0417164300', '[IBAN]'],
    ['FR14 2004 1010 0505 0001 3M02 606', '[IBAN]'],
  ])('%j', (input, expected) => {
    expect(text(input)).toBe(expected)
  })

  it('leaves a wrong checksum alone', () => {
    expect(text('GB82 WEST 1234 5698 7654 33')).toBe('GB82 WEST 1234 5698 7654 33')
  })

  it('accepts any case, but no letter or digit right before it', () => {
    expect(text('gb82 west 1234 5698 7654 32')).toBe('[IBAN]')
    expect(text('iban: de89370400440532013000')).toBe('iban: [IBAN]')
    expect(text('XGB82WEST12345698765432')).toBe('XGB82WEST12345698765432')
    expect(text('GB82WEST12345698765432X')).toBe('GB82WEST12345698765432X')
  })

  it.each([
    ['a word', 'IBAN DE89 3704 0044 0532 0130 00 OK', 'IBAN [IBAN] OK'],
    ['a BIC', 'IBAN DE89 3704 0044 0532 0130 00 BIC COBADEFFXXX', 'IBAN [IBAN] BIC COBADEFFXXX'],
    ['a year', 'pay to GB82 WEST 1234 5698 7654 32 2026', 'pay to [IBAN] 2026'],
    ['a number and a word', 'NL91 ABNA 0417 1643 00 12 times', '[IBAN] 12 times'],
    ['a word, without spaces in the IBAN', 'IBAN DE89370400440532013000 THANKS', 'IBAN [IBAN] THANKS'],
  ])('stops at the country length when followed by %s', (_label, input, expected) => {
    expect(text(input)).toBe(expected)
  })

  it('uses the country length, so a shorter or longer valid-looking run is not an IBAN', () => {
    // Passes mod 97, but has 21 characters where DE needs 22 (later rules may still take its digits).
    expect(text('DE51 3704 0044 0532 0130 0')).not.toContain('[IBAN]')
    // GB needs 22: one extra character glued on makes it no IBAN.
    expect(text('GB82WEST123456987654321')).toBe('GB82WEST123456987654321')
  })

  it('for a country not in the table, takes the longest run that passes', () => {
    // ZZ is not in the table; ZZ72 1234 5678 9012 3 passes mod 97 at 17 characters.
    expect(text('ZZ72 1234 5678 9012 3 OK')).toBe('[IBAN] OK')
    expect(text('ZZ72 1234 5678 9012 3 2026')).toBe('[IBAN] 2026')
  })

  it('knows the length of every listed country', () => {
    expect(IBAN_LENGTHS['DE']).toBe(22)
    expect(IBAN_LENGTHS['NO']).toBe(15)
    expect(IBAN_LENGTHS['RU']).toBe(33)
    expect(Object.keys(IBAN_LENGTHS)).toHaveLength(88)
  })
})

describe('CARD', () => {
  it.each([
    ['card 4111 1111 1111 1111 exp 12/28', 'card [CARD] exp 12/28'],
    ['5500-0000-0000-0004', '[CARD]'],
    ['amex 378282246310005.', 'amex [CARD].'],
    ['4012888888881881 and 6011111111111117', '[CARD] and [CARD]'],
  ])('%j', (input, expected) => {
    expect(text(input)).toBe(expected)
  })

  it('leaves numbers that fail Luhn or have dots alone', () => {
    expect(text('4111 1111 1111 1112')).toBe('4111 1111 1111 1112')
    expect(text('4111.1111.1111.1111')).not.toContain('[CARD]')
  })

  it('needs 13 to 19 digits', () => {
    expect(text('order 123456789012')).toBe('order 123456789012')
  })

  it.each([
    ['a year', 'card 4111 1111 1111 1111 2026', 'card [CARD] 2026'],
    ['more digits after a dash', 'card 4111-1111-1111-1111-99', 'card [CARD]-99'],
    ['another number', 'cc 4111111111111111 1234', 'cc [CARD] 1234'],
    ['an Amex and a number', 'amex 3782 822463 10005 12 times', 'amex [CARD] 12 times'],
  ])('finds a card at the start of a longer run followed by %s', (_label, input, expected) => {
    expect(text(input)).toBe(expected)
  })

  it('only cuts a longer run at a separator', () => {
    expect(text('41111111111111112026')).toBe('41111111111111112026')
  })

  it('never starts a card inside a run', () => {
    expect(text('ref 12 4111 1111 1111 1111')).not.toContain('[CARD]')
  })
})

describe('BANK_ACCOUNT', () => {
  it.each([
    ['send it to account 12345678 please', 'send it to account [BANK_ACCOUNT] please'],
    ['Acct no: 123-456-7890', 'Acct no: [BANK_ACCOUNT]'],
    ['a/c 0012 3456 7890', 'a/c [BANK_ACCOUNT]'],
    ['routing 021000021, account 9876543210', 'routing [BANK_ACCOUNT], account [BANK_ACCOUNT]'],
    ['BANK: Chase 1234.5678.9012', 'BANK: Chase [BANK_ACCOUNT]'],
  ])('%j', (input, expected) => {
    expect(text(input)).toBe(expected)
  })

  it.each([
    ['keyword inside a word', 'accountant 12345678'],
    ['too far from the keyword (21 characters)', 'account for the flat rentxx 12345678'],
    ['a digit before the number', 'account 12 days 12345678'],
    ['too short (5 digits)', 'account 12345'],
    ['too long (18 digits)', 'account 123456789012345678'],
  ])('leaves %s alone', (_label, input) => {
    expect(text(input)).toBe(input)
  })

  it('allows exactly 20 characters between keyword and number', () => {
    expect(text('account for the flat rentx 12345678')).toBe('account for the flat rentx [BANK_ACCOUNT]')
  })
})

describe('NATIONAL_ID', () => {
  it.each([
    ['my SSN is 123-45-6789', 'my SSN is [NATIONAL_ID]'],
    ['078-05-1120.', '[NATIONAL_ID].'],
    ['passport no. X1234567', 'passport no. [NATIONAL_ID]'],
    ['ID number: AB123456', 'ID number: [NATIONAL_ID]'],
    ['National ID 900101123456', 'National ID [NATIONAL_ID]'],
  ])('%j', (input, expected) => {
    expect(text(input)).toBe(expected)
  })

  it.each([
    ['Singapore NRIC', 'NRIC S1234567D'],
    ['Singapore NRIC, T series', 'my IC is T0123456G'],
    ['Singapore FIN', 'FIN F9876543M'],
    ['Singapore FIN, G series', 'here G1111111X'],
    ['Spain DNI', 'DNI 12345678Z'],
    ['Spain NIE', 'here X1234567L'],
    ['Spain NIE, Y', 'NIE Y7654321G'],
    ['Italy codice fiscale', 'codice fiscale RSSMRA85T10A562S'],
    ['Italy codice fiscale, no keyword', 'here DOEJNA90A41F205E'],
    ['Mexico CURP', 'CURP GODE561231HDFRRN00'],
    ['Mexico CURP, no keyword', 'here DOEJ900101MDFRRN08'],
    ['UK NI number', 'NI number AB123456C'],
    ['UK NI number, spaced', 'national insurance AB 12 34 56 C'],
  ])('finds a checked ID shape: %s', (_label, input) => {
    expect(redact(input).counts.NATIONAL_ID).toBe(1)
    expect(text(input)).toMatch(/\[NATIONAL_ID\]$/)
  })

  it.each([
    ['an NRIC with a wrong check letter', 'S1234567A'],
    ['a DNI with a wrong check letter', '12345678A'],
    ['a NIE with a wrong check letter', 'X1234567A'],
    ['a codice fiscale with a wrong check letter', 'RSSMRA85T10A562A'],
    ['a CURP with a wrong check digit', 'GODE561231HDFRRN01'],
    ['a UK NI number with a prefix HMRC never uses', 'GB123456C'],
    ['a UK NI number with a suffix above D', 'AB123456E'],
    ['a lowercase NRIC', 's1234567d'],
  ])('leaves %s alone', (_label, input) => {
    expect(redact(input).counts.NATIONAL_ID).toBe(0)
  })

  it.each([
    ['NIK 3201234567890001', 'NIK [NATIONAL_ID]'],
    ['no KTP: 3201234567890001.', 'no KTP: [NATIONAL_ID].'],
    ['aadhaar 1234 5678 9012', 'aadhaar [NATIONAL_ID]'],
    ['CPF 123.456.789-09', 'CPF [NATIONAL_ID]'],
    ['my IC 850101-14-5678', 'my IC [NATIONAL_ID]'],
    ['PAN ABCDE1234F', 'PAN [NATIONAL_ID]'],
    ["driver's license D1234567", "driver's license [NATIONAL_ID]"],
    ['licence no DOE99701JD9AB', 'licence no [NATIONAL_ID]'],
    ['SIN 046 454 286', 'SIN [NATIONAL_ID]'],
    ['my number 1234 5678 9012', 'my number [NATIONAL_ID]'],
    ['NPWP 09.254.294.3-407.000', 'NPWP [NATIONAL_ID]'],
  ])('finds an ID after a local or English keyword: %j', (input, expected) => {
    expect(text(input)).toBe(expected)
  })

  it.each([
    ['a keyword used as a word', 'the pan was 2000 degrees'],
    ['a keyword inside a word', 'panic ABCD1234'],
    ['an ID with letters split by spaces', 'PAN ABCDE 1234 F'],
    ['an ID longer than 20 characters', 'NIK 1234567890123456789012'],
  ])('leaves %s alone', (_label, input) => {
    expect(redact(input).counts.NATIONAL_ID).toBe(0)
  })

  it('stops the ID before a word that follows it', () => {
    expect(text('ID number: AB123456 OK')).toBe('ID number: [NATIONAL_ID] OK')
  })

  it.each([
    ['an SSN inside a longer number', '1123-45-6789'],
    ['an ID with fewer than 4 digits', 'passport ABC123DE'],
    ['a lowercase ID', 'passport x1234567'],
    ['an ID without a keyword', 'ref X1234567'],
  ])('leaves %s alone', (_label, input) => {
    expect(text(input)).toBe(input)
  })
})

describe('PHONE', () => {
  it.each([
    ['call +1 415 555 0132!', 'call [PHONE]!'],
    ['+44 20 7946 0958 or 020 7946 0958', '[PHONE] or [PHONE]'],
    ['(415) 555-0132', '[PHONE]'],
    ['415-555-0132 and 415.555.0132', '[PHONE] and [PHONE]'],
    ['0044 20 7946 0958', '[PHONE]'],
    ['+81-3-1234-5678', '[PHONE]'],
  ])('%j', (input, expected) => {
    expect(text(input)).toBe(expected)
  })

  it.each([
    ['money', 'price 2.500.000 or best offer'],
    ['a big amount', 'about 15.000.000.000 total'],
    ['a short code', 'code 123456'],
    ['a date', 'on 2026-11-03'],
    ['a national number that is too short', '0207 946 09'],
    ['right after a letter', 'tel0207946095'],
    ['followed by a letter', '+442079460958x'],
  ])('leaves %s alone', (_label, input) => {
    expect(text(input)).toBe(input)
  })
})

describe('HANDLE', () => {
  it.each([
    ['follow @john_doe & @jane.d.', 'follow [HANDLE] & [HANDLE].'],
    ['dm @_x', 'dm [HANDLE]'],
    ['@a', '[HANDLE]'],
  ])('%j', (input, expected) => {
    expect(text(input)).toBe(expected)
  })

  it('leaves emails to the email rule and ignores odd handles', () => {
    expect(text('x@gmail.com')).toBe('[EMAIL]')
    expect(text('@.john')).toBe('@.john')
    expect(text('@')).toBe('@')
    expect(text(`@${'a'.repeat(31)}`)).toBe(`@${'a'.repeat(31)}`)
    expect(text(`@${'a'.repeat(30)}`)).toBe('[HANDLE]')
  })
})

describe('hidden digits', () => {
  it.each([
    ['digit words', 'call zero eight one two three four five six seven eight nine', 'call [PHONE]'],
    ['words with double and oh', 'call me on o seven seven double oh, nine double oh, one two three four', 'call me on [PHONE]'],
    ['words mixed with digits', 'wa 0812 three four five six 7890 ok', 'wa [PHONE] ok'],
    ['letter O for zero', 'wa O812 3456 789O', 'wa [PHONE]'],
    ['letter l for one', 'card 4111 l111 1111 1111', 'card [CARD]'],
    ['full-width digits', 'wa ０８１２３４５６７８９０', 'wa [PHONE]'],
    ['Arabic-Indic digits', 'wa ٠٨١٢٣٤٥٦٧٨٩٠', 'wa [PHONE]'],
    ['keycap emoji', 'wa 0️⃣8️⃣1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣8️⃣9️⃣0️⃣', 'wa [PHONE]'],
  ])('decodes %s', (_label, input, expected) => {
    expect(text(input)).toBe(expected)
  })

  it.each([
    ['counting in words', 'one, two, three, four, five, six, seven'],
    ['a rating in keycap emoji', 'I give it 1️⃣0️⃣ out of 1️⃣0️⃣'],
    ['emoji with a variation selector', '❤️❤️❤️'],
    ['an order number with a letter O', 'Order #O3412024 never arrived'],
    ['a few words', 'one or two times, nine nine nine'],
    ['full-width digits that are no phone', 'room ４０４'],
    ['lookalikes with too few digits', 'card 4lll llll llll llll'],
  ])('leaves %s exactly as written', (_label, input) => {
    expect(text(input)).toBe(input)
  })

  it('counts a decoded phone as a phone', () => {
    expect(redact('wa ０８１２３４５６７８９０').counts).toEqual({ ...zero, PHONE: 1 })
  })
})

describe('contact after an app name', () => {
  it.each([
    ['my ig is jane.doe99', 'my ig is [HANDLE]'],
    ['add me ig: janedoe', 'add me ig: [HANDLE]'],
    ['IG - jane_doe', 'IG - [HANDLE]'],
    ['line id janedoe85', 'line id [HANDLE]'],
    ['LINE ID: janedoe', 'LINE ID: [HANDLE]'],
    ['telegram username is janedoe', 'telegram username is [HANDLE]'],
    ['snap jane_doe', 'snap [HANDLE]'],
    ['discord jane.doe', 'discord [HANDLE]'],
    ['wechat = jdoe2026', 'wechat = [HANDLE]'],
  ])('%j', (input, expected) => {
    expect(text(input)).toBe(expected)
  })

  it.each([
    ['a plain word after is', 'my ig is private'],
    ['a plain word after a space', 'add me on telegram please'],
    ['an app name inside a word', 'online: janedoe'],
    ['a name that is too short', 'ig: jd'],
  ])('leaves %s alone', (_label, input) => {
    expect(text(input)).toBe(input)
  })

  it('leaves a handle with @ to the handle rule, counted once', () => {
    expect(redact('tg @jane_doe')).toEqual({ text: 'tg [HANDLE]', counts: { ...zero, HANDLE: 1 } })
  })
})

describe('redact', () => {
  it('counts every kind', () => {
    const r = redact(
      'Hi, I am John @john_doe. Call +1 415 555 0132 or (415) 555-0199, email john@x.io, ' +
        'card 4111 1111 1111 1111, IBAN GB82 WEST 1234 5698 7654 32, account 12345678, ' +
        'SSN 123-45-6789, see https://promo.example, pay $JohnDoe, BTC 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa, ' +
        'ip 8.8.8.8, at -6.20881, 106.84562',
    )
    expect(r.text).toBe(
      'Hi, I am John [HANDLE]. Call [PHONE] or [PHONE], email [EMAIL], ' +
        'card [CARD], IBAN [IBAN], account [BANK_ACCOUNT], ' +
        'SSN [NATIONAL_ID], see [URL], pay [PAYMENT_HANDLE], BTC [CRYPTO], ' +
        'ip [IP], at [LOCATION]',
    )
    expect(r.counts).toEqual({
      URL: 1,
      EMAIL: 1,
      PAYMENT_HANDLE: 1,
      CRYPTO: 1,
      IP: 1,
      LOCATION: 1,
      IBAN: 1,
      CARD: 1,
      BANK_ACCOUNT: 1,
      NATIONAL_ID: 1,
      PHONE: 2,
      HANDLE: 1,
    })
  })

  it('never changes its input', () => {
    const input = 'call +1 415 555 0132, IBAN GB82 WEST 1234 5698 7654 32'
    const copy = String(input)
    redact(input)
    expect(input).toBe(copy)
  })

  it('returns zero counts for clean text and keeps it unchanged', () => {
    expect(redact('he was rude, please take a look')).toEqual({ text: 'he was rude, please take a look', counts: zero })
    expect(redact('')).toEqual({ text: '', counts: zero })
  })

  it('works across lines', () => {
    expect(text('a@b.co\n+1 415 555 0132\n@jane')).toBe('[EMAIL]\n[PHONE]\n[HANDLE]')
  })
})
