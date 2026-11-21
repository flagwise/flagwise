// Boundary rules: no service imports another; shared packages never import services or apps; the behaviour scenarios see the product only from outside.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-service-imports',
      comment: 'A service imports only contracts, kernel and platform, never another service, so each can boot and change alone.',
      severity: 'error',
      from: { path: '^packages/modules/([^/]+)/' },
      to: { path: '^packages/modules/', pathNot: '^packages/modules/$1/' },
    },
    {
      name: 'shared-packages-stay-below-modules',
      comment: 'kernel, contracts, plugin-api and platform must not depend on modules or apps.',
      severity: 'error',
      from: { path: '^packages/(kernel|contracts|plugin-api|platform)/' },
      to: { path: '^(packages/modules|apps)/' },
    },
    {
      name: 'no-app-imports-from-packages',
      comment: 'Packages never import from apps/.',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'behaviour-sees-only-the-outside',
      comment: 'The behaviour scenarios see Flagwise only from outside: the server, kernel and platform, never a service. They live in scenarios/, not test/, so this rule covers them.',
      severity: 'error',
      from: { path: '^behaviour/' },
      to: { path: '^(packages/modules|packages/plugin-api)/' },
    },
    {
      name: 'not-to-unresolvable',
      comment: 'Every import resolves, so the rules above see where it goes: a service importing a package it does not depend on fails here.',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(node_modules|test)/' },
    // dependency-cruiser does not support TypeScript 7 yet; swc parses the .ts sources instead.
    parser: 'swc',
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'default'] },
  },
}
