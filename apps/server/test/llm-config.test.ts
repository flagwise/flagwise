import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifierPrompt, loadGuidance } from '@flagwise/classify'
import { describe, expect, it } from 'vitest'
import { llmFromEnv } from '../src/index.ts'

describe('llmFromEnv', () => {
  it('runs without an LLM, redacting, when nothing is set', async () => {
    expect(await llmFromEnv({})).toEqual({ llm: undefined, redact: true })
    expect(await llmFromEnv({ LLM_PROVIDER: ' ', LLM_REDACTION: 'false' })).toEqual({ llm: undefined, redact: false })
  })

  it('sets up Anthropic with its default models and the shipped guidance', async () => {
    const { llm } = await llmFromEnv({ LLM_PROVIDER: 'anthropic', LLM_API_KEY: 'sk-test' })
    expect(llm).toMatchObject({ model: 'claude-haiku-5-5', escalationModel: 'claude-sonnet-5-5', prompt: classifierPrompt(await loadGuidance()) })
  })

  it('takes the models and the guidance file from the environment, and sends to the base URL', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'guidance-')), 'prompt.md')
    writeFileSync(file, 'Answer only with the JSON object.')
    const urls: string[] = []
    const fetch = (async (url: string) => {
      urls.push(String(url))
      return new Response('{}', { status: 500 })
    }) as unknown as typeof globalThis.fetch
    const { llm } = await llmFromEnv(
      { LLM_PROVIDER: 'anthropic', LLM_API_KEY: 'sk-test', LLM_BASE_URL: 'http://gateway.local', LLM_MODEL: 'small', LLM_ESCALATION_MODEL: 'strong', LLM_PROMPT_FILE: file },
      { fetch },
    )
    expect(llm).toMatchObject({ model: 'small', escalationModel: 'strong', prompt: classifierPrompt('Answer only with the JSON object.') })
    await expect(llm!.provider.complete({ model: 'small', system: 's', input: 'i', schema: {}, maxTokens: 10 })).rejects.toThrow()
    expect(urls[0]).toMatch(/^http:\/\/gateway\.local\//)
  })

  it('sets up an OpenAI-compatible server, with no key and the same model for escalation', async () => {
    const bodies: Record<string, unknown>[] = []
    const urls: string[] = []
    const fetch = (async (url: string, init: RequestInit) => {
      urls.push(String(url))
      bodies.push(JSON.parse(String(init.body)))
      return new Response('{}', { status: 400 })
    }) as unknown as typeof globalThis.fetch
    const env = { LLM_PROVIDER: 'openai-compatible', LLM_BASE_URL: 'http://ollama.local:11434/v1', LLM_MODEL: 'llama3.3' }
    const { llm } = await llmFromEnv(env, { fetch })
    expect(llm).toMatchObject({ model: 'llama3.3', escalationModel: 'llama3.3' })
    await expect(llm!.provider.complete({ model: 'llama3.3', system: 's', input: 'i', schema: {}, maxTokens: 10 })).rejects.toThrow()
    expect(urls[0]).toBe('http://ollama.local:11434/v1/chat/completions')
    expect(bodies[0]!.response_format).toMatchObject({ type: 'json_schema' })

    const object = await llmFromEnv({ ...env, LLM_JSON_MODE: 'object', LLM_ESCALATION_MODEL: 'llama3.3:70b' }, { fetch })
    expect(object.llm).toMatchObject({ escalationModel: 'llama3.3:70b' })
    await expect(object.llm!.provider.complete({ model: 'llama3.3', system: 's', input: 'i', schema: {}, maxTokens: 10 })).rejects.toThrow()
    expect(bodies[1]!.response_format).toEqual({ type: 'json_object' })
  })

  it('sets up Gemini with the given model for both steps, and sends to the base URL', async () => {
    const urls: string[] = []
    const fetch = (async (url: string) => {
      urls.push(String(url))
      return new Response('{}', { status: 400 })
    }) as unknown as typeof globalThis.fetch
    const { llm } = await llmFromEnv({ LLM_PROVIDER: 'gemini', LLM_API_KEY: 'gm-test', LLM_MODEL: 'gemini-flash', LLM_BASE_URL: 'http://gateway.local' }, { fetch })
    expect(llm).toMatchObject({ model: 'gemini-flash', escalationModel: 'gemini-flash' })
    await expect(llm!.provider.complete({ model: 'gemini-flash', system: 's', input: 'i', schema: {}, maxTokens: 10 })).rejects.toThrow()
    expect(urls[0]).toMatch(/^http:\/\/gateway\.local\/.*gemini-flash:generateContent$/)
  })

  it('sets up the fake LLM with no key, on its own model names', async () => {
    const { llm } = await llmFromEnv({ LLM_PROVIDER: 'fake' })
    expect(llm).toMatchObject({ model: 'fake-small', escalationModel: 'fake-strong' })
    expect(await llmFromEnv({ LLM_PROVIDER: 'fake', LLM_MODEL: 'tiny' })).toMatchObject({ llm: { model: 'tiny', escalationModel: 'fake-strong' } })
  })

  it('refuses settings that would not work', async () => {
    await expect(llmFromEnv({ LLM_PROVIDER: 'gemini', LLM_MODEL: 'm' })).rejects.toThrow('LLM_API_KEY is required with LLM_PROVIDER=gemini')
    await expect(llmFromEnv({ LLM_PROVIDER: 'gemini', LLM_API_KEY: 'k' })).rejects.toThrow('LLM_MODEL is required with LLM_PROVIDER=gemini')
    await expect(llmFromEnv({ LLM_PROVIDER: 'openai-compatible', LLM_MODEL: 'm' })).rejects.toThrow('LLM_BASE_URL is required with LLM_PROVIDER=openai-compatible')
    await expect(llmFromEnv({ LLM_PROVIDER: 'openai-compatible', LLM_BASE_URL: 'http://x' })).rejects.toThrow('LLM_MODEL is required with LLM_PROVIDER=openai-compatible')
    await expect(llmFromEnv({ LLM_PROVIDER: 'openai-compatible', LLM_BASE_URL: 'http://x', LLM_MODEL: 'm', LLM_JSON_MODE: 'text' })).rejects.toThrow(
      'LLM_JSON_MODE must be schema or object (got "text")',
    )
    await expect(llmFromEnv({ LLM_PROVIDER: 'anthropic' })).rejects.toThrow('LLM_API_KEY is required with LLM_PROVIDER=anthropic')
    await expect(llmFromEnv({ LLM_PROVIDER: 'gpt', LLM_API_KEY: 'k' })).rejects.toThrow('LLM_PROVIDER must be anthropic, openai-compatible, gemini, fake or empty (got "gpt")')
    await expect(llmFromEnv({ LLM_REDACTION: 'yes' })).rejects.toThrow('LLM_REDACTION must be true or false (got "yes")')
    await expect(llmFromEnv({ LLM_PROVIDER: 'anthropic', LLM_API_KEY: 'k', LLM_PROMPT_FILE: '/nope/prompt.md' })).rejects.toThrow(/ENOENT/)
  })
})
