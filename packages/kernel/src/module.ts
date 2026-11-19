// Each module's index.ts exports one definition; apps/server wires them together.

export interface ModuleDefinition {
  /** Also the module's Postgres schema name. */
  readonly name: string
}

export function defineModule<const M extends ModuleDefinition>(def: M): M {
  return def
}
