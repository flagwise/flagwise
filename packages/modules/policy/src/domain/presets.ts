// The starter category lists an app can begin with: report-screen labels in English and
// Indonesian, each mapped to global groups. P0 categories need no label: they are detected in every
// report whatever the reporter picked.

import type { AppCategory } from './categories.ts'

export type PresetName = 'dating' | 'marketplace' | 'community'

export const PRESET_NAMES: readonly PresetName[] = ['dating', 'marketplace', 'community']

const label = (key: string, en: string, id: string, mapsTo: readonly string[]): AppCategory => ({
  key,
  label: { en, id },
  mapsTo,
  severity: null,
  slaHours: null,
  enabled: true,
})

const RUDE = label('rude_or_harassing', 'Rude or harassing', 'Kasar atau melecehkan', ['harassment', 'hate_speech'])
const OTHER = label('other', 'Other', 'Lainnya', ['other'])

export const PRESETS: Readonly<Record<PresetName, readonly AppCategory[]>> = {
  dating: [
    label('fake_profile', 'Fake profile', 'Profil palsu', ['fake_identity']),
    label('asking_for_money', 'Asking for money or a scam', 'Minta uang atau penipuan', ['scams_fraud']),
    RUDE,
    label('sexual_content', 'Sexual content', 'Konten seksual', ['sexual_exploitation', 'sexual_content']),
    label('might_be_underage', 'Might be underage', 'Mungkin di bawah umur', ['child_safety']),
    label('threatening_or_dangerous', 'Threatening or dangerous', 'Mengancam atau berbahaya', ['threats_violence', 'self_harm']),
    label('problem_meeting_up', 'Problem when meeting up', 'Masalah saat bertemu', ['offline_behavior']),
    label('spam_or_selling', 'Spam or selling', 'Spam atau jualan', ['spam']),
    OTHER,
  ],
  marketplace: [
    label('scam', 'Scam', 'Penipuan', ['scams_fraud']),
    label('prohibited_item', 'Prohibited item', 'Barang terlarang', ['prohibited_goods']),
    label('counterfeit', 'Counterfeit', 'Barang palsu', ['intellectual_property']),
    label('misleading_info', 'Misleading information', 'Informasi menyesatkan', ['consumer_protection']),
    RUDE,
    label('spam', 'Spam', 'Spam', ['spam']),
    OTHER,
  ],
  community: [
    label('hate', 'Hate', 'Ujaran kebencian', ['hate_speech']),
    label('harassment', 'Harassment', 'Pelecehan', ['harassment']),
    label('sexual_content', 'Sexual content', 'Konten seksual', ['sexual_exploitation', 'sexual_content']),
    label('violence_or_threats', 'Violence or threats', 'Kekerasan atau ancaman', ['terrorism', 'threats_violence']),
    label('self_harm', 'Self-harm', 'Menyakiti diri sendiri', ['self_harm']),
    label('spam_or_scam', 'Spam or scam', 'Spam atau penipuan', ['scams_fraud', 'spam']),
    label('misinformation', 'Misinformation', 'Misinformasi atau hoaks', ['misinformation']),
    OTHER,
  ],
}
