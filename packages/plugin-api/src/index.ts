// The seam between the open-source core and anything built on it.
// Self-host runs with the built-in defaults; flagwise-cloud passes its plugins to createApp() at build time.

export interface PluginContext {
  // Registration hooks (entitlements, usage, keys, alerts, email, support, routes, UI slots) are added as each seam is built.
}

export interface FlagwisePlugin {
  readonly name: string
  register(ctx: PluginContext): void
}
