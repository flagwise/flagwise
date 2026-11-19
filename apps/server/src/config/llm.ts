// The install's LLM, from the environment. Every app of the install uses it; an app can only turn
// it off.

import { ANTHROPIC_MODELS, anthropicProvider, classifierPrompt, FAKE_MODELS, fakeProvider, geminiProvider, loadGuidance, openAiCompatibleProvider, type LlmConfig } from '@flagwise/classify'

export interface LlmSettings {
  /** Undefined when LLM_PROVIDER is unset: every case is classified by rules. */
  readonly llm: LlmConfig | undefined
  readonly redact: boolean
}

type Env = Readonly<Record<string, string | undefined>>

/**
 * Reads:
 * - LLM_PROVIDER: anthropic, openai-compatible, gemini, fake (no network or key: answers from the
 *   report's text, the same every time; for local development and tests), or empty for no LLM.
 * - LLM_API_KEY: required for anthropic and gemini; optional for openai-compatible (a local Ollama
 *   needs none).
 * - LLM_BASE_URL: required for openai-compatible; optional otherwise (a proxy or gateway).
 * - LLM_MODEL: optional for anthropic and fake (their default models); required otherwise.
 * - LLM_ESCALATION_MODEL: optional; anthropic's or fake's default, else LLM_MODEL.
 * - LLM_JSON_MODE: openai-compatible only, schema (default) or object.
 * - LLM_PROMPT_FILE: optional guidance file, else the one shipped with classify.
 * - LLM_REDACTION: true (default) or false.
 *
 * Throws on an unknown provider, a missing required setting, an unreadable or empty prompt file, or
 * a bad LLM_REDACTION or LLM_JSON_MODE, so a wrong setting stops the install from starting.
 */
export async function llmFromEnv(env: Env, options: { readonly fetch?: typeof fetch } = {}): Promise<LlmSettings> {
  const value = (name: string) => {
    const v = env[name]?.trim()
    return v === undefined || v === '' ? undefined : v
  }

  const redaction = value('LLM_REDACTION') ?? 'true'
  if (redaction !== 'true' && redaction !== 'false') throw new Error(`LLM_REDACTION must be true or false (got "${redaction}")`)
  const redact = redaction === 'true'

  const provider = value('LLM_PROVIDER')
  if (provider === undefined) return { llm: undefined, redact }
  const required = (name: string) => {
    const v = value(name)
    if (v === undefined) throw new Error(`${name} is required with LLM_PROVIDER=${provider}`)
    return v
  }
  const apiKey = value('LLM_API_KEY')
  const baseURL = value('LLM_BASE_URL')
  const fetch = options.fetch ? { fetch: options.fetch } : {}

  let llm: Omit<LlmConfig, 'prompt'>
  switch (provider) {
    case 'anthropic':
      llm = {
        provider: anthropicProvider({ apiKey: required('LLM_API_KEY'), ...(baseURL ? { baseURL } : {}), ...fetch }),
        model: value('LLM_MODEL') ?? ANTHROPIC_MODELS.model,
        escalationModel: value('LLM_ESCALATION_MODEL') ?? ANTHROPIC_MODELS.escalationModel,
      }
      break
    case 'openai-compatible': {
      const jsonMode = value('LLM_JSON_MODE') ?? 'schema'
      if (jsonMode !== 'schema' && jsonMode !== 'object') throw new Error(`LLM_JSON_MODE must be schema or object (got "${jsonMode}")`)
      const model = required('LLM_MODEL')
      llm = {
        provider: openAiCompatibleProvider({ baseURL: required('LLM_BASE_URL'), ...(apiKey ? { apiKey } : {}), jsonMode, ...fetch }),
        model,
        escalationModel: value('LLM_ESCALATION_MODEL') ?? model,
      }
      break
    }
    case 'gemini': {
      const model = required('LLM_MODEL')
      llm = {
        provider: geminiProvider({ apiKey: required('LLM_API_KEY'), ...(baseURL ? { baseURL } : {}), ...fetch }),
        model,
        escalationModel: value('LLM_ESCALATION_MODEL') ?? model,
      }
      break
    }
    case 'fake':
      llm = {
        provider: fakeProvider(),
        model: value('LLM_MODEL') ?? FAKE_MODELS.model,
        escalationModel: value('LLM_ESCALATION_MODEL') ?? FAKE_MODELS.escalationModel,
      }
      break
    default:
      throw new Error(`LLM_PROVIDER must be anthropic, openai-compatible, gemini, fake or empty (got "${provider}")`)
  }
  return { llm: { ...llm, prompt: classifierPrompt(await loadGuidance(value('LLM_PROMPT_FILE'))) }, redact }
}
