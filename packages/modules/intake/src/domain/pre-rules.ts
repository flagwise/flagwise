// Pre-rules: patterns checked when a report arrives, before any LLM, in English and Indonesian
// (including common slang). They find P0 signals the LLM can never lower, and text that tries to
// steer the classifier. A match only raises attention; it never decides a case on its own. Intake
// is their only runner: report.received carries what they found.

import { P0_SIGNALS, type P0Signal } from '@flagwise/contracts'

export interface PreRuleResult {
  /** The P0 signals found, in P0_SIGNALS order, each once. */
  readonly p0Signals: readonly P0Signal[]
  readonly injectionSuspected: boolean
}

// Words for "you" and "I" in English and Indonesian chat.
const YOU = String.raw`(?:you|u|ya|lo|lu|loe|elo|elu|kamu|kau|km)`
// "I will" in English; Indonesian marks intent with an optional word after the pronoun.
const I_WILL_EN = String.raw`(?:i'?ll|i will|i'?m going to|i am going to|im gonna|i'?m gonna|gonna)`
const I_ID = String.raw`(?:aku|gue|gw|gua|saya|ane)\s+(?:akan\s+|mau\s+|bakal\s+|pasti\s+)?`
// An age a child could be: 5 to 17.
const CHILD_AGE = String.raw`(?:1[0-7]|[5-9])`

const P0_PATTERNS: Readonly<Record<P0Signal, readonly RegExp[]>> = {
  minor_involved: [
    new RegExp(String.raw`\b(?:i'?m|i am|im|she'?s|she is|he'?s|he is|they'?re|they are|aged?)\s+(?:only\s+|just\s+)?${CHILD_AGE}\b(?!\s*(?:k\b|%|\$|\/|'|am\b|pm\b|min|minutes|hours|days|weeks|months|cm|kg))`, 'i'),
    new RegExp(String.raw`\b${CHILD_AGE}\s*(?:y\/?o|yrs?\s*old|years?\s*old|year-old)\b`, 'i'),
    /\b(?:umur|umurnya|usia|usianya)\s+(?:baru\s+|masih\s+)?(?:1[0-7]|[5-9])\b/i,
    /\b(?:masih|anak|murid|siswa|siswi)\s+(?:sd|smp|sma)\b/i,
    /\b(?:under\s*age|underaged|di\s*bawah\s*umur|bawah\s*umur)\b/i,
    /\b(?:child|kid|minor|teen)\s*(?:porn|nudes?|sex)\b/i,
    /\b(?:pedo|pedofil|pedophile|paedophile|csam)\b/i,
  ],
  credible_threat: [
    new RegExp(String.raw`\b${I_WILL_EN}\s+(?:kill|murder|stab|shoot|hurt|beat up|rape)\s+${YOU}\b`, 'i'),
    new RegExp(String.raw`\b${I_ID}(?:bunuh|habisin|tusuk|bacok|tembak|hajar|perkosa)\s+${YOU}\b`, 'i'),
    /\b(?:i know where you live|i know your address|i'?ll find you|watch your back)\b/i,
    /\b(?:gue|gw|aku|saya)\s+(?:tau|tahu)\s+(?:rumah|alamat)\s*(?:lo|lu|kamu|mu)\b/i,
    /\b(?:tahu|tau)\s+rumahmu\b/i,
    /\b(?:you'?re|you are|u r)\s+(?:dead|gonna die)\b/i,
    /\b(?:mati\s+(?:lo|lu|kau|kamu)|awas\s+(?:lo|lu|kamu)\s+ya)\b/i,
  ],
  self_harm_intent: [
    /\b(?:kill|killing|hurt|hurting|cut|cutting)\s+myself\b/i,
    /\b(?:unalive|unaliving)\s+(?:myself|me)\b/i,
    /\b(?:suicide|suicidal)\b/i,
    /\b(?:end it all|end my life|want to die|wanna die|don'?t want to live)\b/i,
    /\b(?:bunuh\s+diri|akhiri\s+hidup|akhirin\s+hidup|nyakitin\s+diri|melukai\s+diri)\b/i,
    /\b(?:pengen|pingin|ingin|mau)\s+mati\b/i,
  ],
  terrorism: [
    /\b(?:isis|isil|daesh|al[- ]?qaeda|jamaah islamiyah)\b/i,
    /\b(?:bomb|blow up|shoot up)\s+(?:the|a|this|that)\s+(?:school|mall|church|mosque|temple|station|concert|crowd|office|airport)\b/i,
    /\b(?:mass shooting|suicide bomb(?:ing|er)?)\b/i,
    /\bbom\s+bunuh\s+diri\b/i,
    /\b(?:ngebom|meledakkan|bom)\s+(?:sekolah|gereja|masjid|mal|stasiun|bandara|kantor)\b/i,
  ],
  sexual_exploitation: [
    new RegExp(String.raw`\b(?:leak|post|share|spread|send)\s+(?:your|ur)\s+(?:nudes|naked|pics|photos|video|vid)\b`, 'i'),
    /\b(?:send|kirim)\s+(?:me\s+)?(?:nudes|more nudes|foto bugil)\s+(?:or|atau)\b/i,
    /\bsextort(?:ion|ing)?\b/i,
    /\b(?:sebar|sebarin|sebarkan|viralin|viralkan)\s+(?:foto|video|vid|pap)\b/i,
    /\b(?:foto|video)\s+(?:bugil|telanjang)\s*(?:mu|lo|lu|kamu)\b/i,
  ],
}

const INJECTION_PATTERNS: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+|your\s+)?(?:previous|prior|above|earlier|system)\s+(?:instructions?|rules?|prompts?|messages?)\b/i,
  /\b(?:you are now|from now on you are|act as|pretend to be)\s+(?:a|an|the)?\s*(?:different|new|unrestricted|ai|assistant|moderator|classifier|dan)\b/i,
  /\b(?:system prompt|developer mode|jailbreak|dan mode)\b/i,
  /\b(?:new|updated|real)\s+instructions?\s*:/i,
  /\b(?:classify|categorize|label|mark)\s+(?:this|it|me|the report)\s+as\s+(?:safe|benign|not a violation|no violation|harmless|spam|other)\b/i,
  /\b(?:set|change)\s+(?:the\s+)?(?:severity|priority|confidence|category)\s+to\b/i,
  /\binjection_suspected\b|\bcategory_id\b/i,
  /<\/?\s*(?:system|instructions?|report_data|assistant)\s*>/i,
  /\b(?:abaikan|lupakan|acuhkan)\s+(?:semua\s+)?(?:instruksi|perintah|aturan|prompt)\b/i,
  /\b(?:kamu|anda)\s+sekarang\s+(?:adalah|jadi|menjadi)\b/i,
  /\b(?:klasifikasikan|kategorikan|tandai)\s+(?:ini|laporan ini|aku|saya)?\s*(?:sebagai|jadi)\s+(?:aman|bukan pelanggaran|tidak melanggar)\b/i,
]

/**
 * Runs the pre-rules over the given texts (report text, evidence messages, the reporter's picked
 * category). Texts are compared after Unicode NFKC normalization, so full-width and other look-alike
 * forms match too. Returns the P0 signals found and whether any text looks like an attempt to steer
 * the classifier.
 */
export function preRules(texts: readonly string[]): PreRuleResult {
  const normalized = texts.map((t) => t.normalize('NFKC').replace(/[‘’]/g, "'").replace(/\s+/g, ' '))
  const p0Signals = P0_SIGNALS.filter((signal) => P0_PATTERNS[signal].some((re) => normalized.some((t) => re.test(t))))
  const injectionSuspected = INJECTION_PATTERNS.some((re) => normalized.some((t) => re.test(t)))
  return { p0Signals, injectionSuspected }
}

/** The parts of a report the pre-rules read. */
export interface ScreenedReport {
  readonly category: string
  readonly text?: string | undefined
  readonly evidence: { readonly content: readonly { readonly text: string }[] }
}

/** Every text of the report the pre-rules look at: the reporter's category and text, and the messages. */
export function reportTexts(r: ScreenedReport): string[] {
  return [r.category, ...(r.text === undefined ? [] : [r.text]), ...r.evidence.content.map((m) => m.text)]
}
