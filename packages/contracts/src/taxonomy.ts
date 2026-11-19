// The global report taxonomy: the category ids every app maps to, used in the API, webhooks, the
// classifier's output and the DSA export. Ids are `{group}.{subcategory}` and never change once
// released; a label can.

export type GlobalSeverity = 'P0' | 'P1' | 'P2'

/**
 * The signals that make a case P0 whatever its category: flagging's pre-rules find them in the
 * report, the classifier may add them, and triage raises severity on any of them.
 */
export const P0_SIGNALS = ['minor_involved', 'credible_threat', 'self_harm_intent', 'terrorism', 'sexual_exploitation'] as const

export type P0Signal = (typeof P0_SIGNALS)[number]

/** Whether any of the signals is one that makes a case P0 whatever its category. */
export function hasP0Signal(signals: readonly string[]): boolean {
  return signals.some((s) => (P0_SIGNALS as readonly string[]).includes(s))
}

export interface GlobalCategory {
  readonly id: string
  readonly group: string
  readonly label: string
  readonly severity: GlobalSeverity
}

const group = (id: string, items: readonly (readonly [string, string, GlobalSeverity])[]): GlobalCategory[] =>
  items.map(([sub, label, severity]) => ({ id: `${id}.${sub}`, group: id, label, severity }))

export const GLOBAL_CATEGORIES: readonly GlobalCategory[] = [
  ...group('child_safety', [
    ['csam', 'Child sexual abuse material, including AI-generated', 'P0'],
    ['grooming', 'Grooming or sexual enticement of a minor', 'P0'],
    ['underage_user', 'Underage user', 'P0'],
  ]),
  ...group('terrorism', [
    ['terrorist_content', 'Terrorist content', 'P0'],
    ['banned_organization', 'Support for a banned organization', 'P0'],
    ['mass_violence_incitement', 'Incitement to mass violence', 'P0'],
  ]),
  ...group('threats_violence', [
    ['threat', 'Threat of violence against a person', 'P0'],
    ['incitement', 'Incitement to violence', 'P0'],
    ['graphic_violence', 'Graphic violence', 'P2'],
  ]),
  ...group('self_harm', [
    ['suicidal_intent', 'Suicidal intent', 'P0'],
    ['self_injury', 'Self-injury', 'P0'],
    ['eating_disorder_promotion', 'Promotion of eating disorders', 'P0'],
    ['dangerous_challenge', 'Dangerous challenge', 'P0'],
  ]),
  ...group('sexual_exploitation', [
    ['ncii', 'Non-consensual intimate imagery', 'P0'],
    ['sextortion', 'Sextortion', 'P0'],
    ['trafficking', 'Human trafficking', 'P0'],
    ['selling_sexual_services', 'Selling sexual services', 'P1'],
  ]),
  ...group('sexual_content', [
    ['unsolicited_sexual_content', 'Unsolicited sexual content (cyberflashing)', 'P1'],
    ['unwanted_advances', 'Unwanted sexual advances', 'P1'],
    ['explicit_profile', 'Explicit profile photo or nudity', 'P2'],
  ]),
  ...group('harassment', [
    ['bullying', 'Harassment or bullying', 'P1'],
    ['intimidation', 'Intimidation', 'P1'],
    ['stalking', 'Stalking', 'P1'],
    ['blackmail', 'Non-sexual blackmail', 'P1'],
    ['coercive_control', 'Coercive control', 'P1'],
  ]),
  ...group('hate_speech', [
    ['hate_speech', 'Hate speech', 'P1'],
    ['incitement_to_hatred', 'Incitement to hatred', 'P1'],
    ['discrimination', 'Discrimination', 'P1'],
  ]),
  ...group('scams_fraud', [
    ['romance_scam', 'Romance scam or asking for money', 'P1'],
    ['investment_scam', 'Investment, crypto or pyramid scheme', 'P1'],
    ['phishing', 'Phishing or malicious links', 'P1'],
    ['account_takeover', 'Account takeover', 'P1'],
    ['illegal_lending', 'Illegal online lending', 'P1'],
  ]),
  ...group('prohibited_goods', [
    ['drugs', 'Drugs', 'P1'],
    ['weapons', 'Weapons', 'P1'],
    ['gambling', 'Online gambling', 'P1'],
    ['protected_wildlife', 'Protected wildlife', 'P1'],
    ['unsafe_products', 'Unsafe or prohibited products', 'P1'],
  ]),
  ...group('privacy', [
    ['doxxing', 'Doxxing or sharing personal data', 'P1'],
    ['non_consensual_media', 'Non-intimate photos or recordings without consent', 'P1'],
    ['data_misuse', 'Data misuse', 'P1'],
  ]),
  ...group('offline_behavior', [
    ['physical_violence', 'Physical violence on a date', 'P0'],
    ['sexual_assault', 'Offline sexual assault', 'P0'],
    ['criminal_history', 'Criminal history', 'P1'],
    ['bad_date', 'Bad date experience', 'P2'],
  ]),
  ...group('fake_identity', [
    ['catfishing', "Catfishing or using someone else's photos", 'P2'],
    ['impersonation', 'Impersonation', 'P2'],
    ['fake_account', 'Bot or fake account', 'P2'],
    ['ban_evasion', 'Duplicate account or ban evasion', 'P2'],
    ['ai_generated_photos', 'AI-generated photos', 'P2'],
  ]),
  ...group('spam', [
    ['spam', 'Spam', 'P2'],
    ['hidden_advertising', 'Promotion or hidden advertising', 'P2'],
    ['off_platform', 'Moving users off the platform', 'P2'],
    ['coordinated_behavior', 'Coordinated behavior', 'P2'],
    ['fake_reviews', 'Fake reviews or listings', 'P2'],
  ]),
  ...group('inappropriate', [
    ['rude_language', 'Rude or vulgar language', 'P2'],
    ['disgusting_content', 'Disgusting content', 'P2'],
    ['tos_violation', 'Other terms-of-service violation', 'P2'],
  ]),
  ...group('misinformation', [
    ['hoax', 'Hoax or disinformation', 'P2'],
    ['election_manipulation', 'Election manipulation', 'P2'],
  ]),
  ...group('intellectual_property', [
    ['copyright', 'Copyright', 'P2'],
    ['trademark', 'Trademark', 'P2'],
    ['counterfeit', 'Counterfeit goods', 'P2'],
  ]),
  ...group('consumer_protection', [
    ['misleading_info', 'Misleading goods or services information', 'P2'],
    ['missing_seller_info', 'Missing seller information', 'P2'],
    ['pricing', 'Pricing non-compliance', 'P2'],
  ]),
  ...group('animal_welfare', [
    ['cruelty', 'Animal cruelty', 'P2'],
    ['illegal_trade', 'Illegal animal trade', 'P2'],
  ]),
  { id: 'other', group: 'other', label: 'Other: nothing above fits', severity: 'P2' },
]

/** The id of the catch-all category: a case that fits nothing else stays here and is flagged. */
export const OTHER_CATEGORY_ID = 'other'

const byId = new Map(GLOBAL_CATEGORIES.map((c) => [c.id, c]))

/** The global category with this id, or undefined. */
export function globalCategory(id: string): GlobalCategory | undefined {
  return byId.get(id)
}

/** The global groups, in taxonomy order. */
export const GLOBAL_GROUPS: readonly string[] = [...new Set(GLOBAL_CATEGORIES.map((c) => c.group))]

/** True when `refs` (global groups or global category ids) names `categoryId`, by its id or its group. */
export function namesCategory(refs: readonly string[], categoryId: string): boolean {
  const category = byId.get(categoryId)
  return category !== undefined && refs.some((r) => r === category.id || r === category.group)
}

/** The global categories `refs` (global groups or global category ids) names, in taxonomy order. */
export function categoriesNamed(refs: readonly string[]): readonly GlobalCategory[] {
  return GLOBAL_CATEGORIES.filter((c) => refs.includes(c.id) || refs.includes(c.group))
}
