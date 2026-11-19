// Reading settings from an environment record, failing loudly on a bad value.

export type Env = Readonly<Record<string, string | undefined>>

export interface EnvReader {
  /** The trimmed value, or undefined when it is unset or blank. */
  value(name: string): string | undefined
  required(name: string): string
  oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T
  /** A whole number of at least `min`. */
  int(name: string, fallback: number, min: number): number
}

export function envReader(env: Env): EnvReader {
  const value = (name: string) => {
    const v = env[name]?.trim()
    return v === undefined || v === '' ? undefined : v
  }
  return {
    value,
    required(name) {
      const v = value(name)
      if (v === undefined) throw new Error(`${name} is required`)
      return v
    },
    oneOf(name, allowed, fallback) {
      const v = value(name) ?? fallback
      if (!(allowed as readonly string[]).includes(v)) throw new Error(`${name} must be ${allowed.join(', ')} (got "${v}")`)
      return v as (typeof allowed)[number]
    },
    int(name, fallback, min) {
      const raw = value(name)
      if (raw === undefined) return fallback
      const n = Number(raw)
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min) throw new Error(`${name} must be a whole number of at least ${min} (got "${raw}")`)
      return n
    },
  }
}
