// Public facade of the classify module. Other modules import only this file.
// Owns: LLM drivers, post-rules, P0 safety layer, prompt-injection defense. The pre-rules are
// flagging's; classify keeps a copy of what they found per report (report.received).

export { classify } from './service.ts'

export * from './domain/classification.ts'
export * from './domain/redact.ts'
export * from './domain/training-screen.ts'
export * from './domain/prompt.ts'
export * from './app/ports.ts'
export { classifyCase, findClassification, recordScreening, retryClassification, ScreeningMissingError, type ClassifyCaseInput } from './app/classify-case.ts'
export { classifyDepsWithPolicy, subscribeClassify, LLM_RETRY_DELAYS_MS, type ClassifyServiceDeps } from './app/handlers.ts'
export { classifyRoutes, type ClassifyEnv } from './api/routes.ts'
export { loadGuidance, DEFAULT_GUIDANCE_FILE } from './infra/prompt-file.ts'
export { openAiCompatibleProvider, type OpenAiCompatibleOptions } from './infra/openai-compatible.ts'
export { geminiProvider, type GeminiProviderOptions } from './infra/gemini.ts'
export { anthropicProvider, ANTHROPIC_MODELS, type AnthropicProviderOptions } from './infra/anthropic.ts'
export { fakeProvider, FAKE_MODELS } from './infra/fake.ts'
export { pgClassificationStore, pgClassifyRunner, classifyMigrations } from './infra/pg-classification-store.ts'
export { classifyTables } from './infra/schema.ts'
export { pgClassifyPolicyCopy } from './infra/pg-policy-copy.ts'
