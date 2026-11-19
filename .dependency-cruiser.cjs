// Module boundary rules: modules import each other only through index.ts; shared packages never import modules or apps.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-module-internals',
      comment: 'A module may import another module only through its index.ts facade.',
      severity: 'error',
      from: { path: '^packages/modules/([^/]+)/' },
      to: {
        path: '^packages/modules/[^/]+/src/',
        pathNot: ['^packages/modules/$1/', '^packages/modules/[^/]+/src/index[.]ts$'],
      },
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
      comment: 'Packages never import from apps/, except the wiring spec, which runs the server from outside.',
      severity: 'error',
      from: { path: '^packages/', pathNot: '^packages/wiring-spec/' },
      to: { path: '^apps/' },
    },
    {
      name: 'wiring-spec-sees-only-the-outside',
      comment: 'The wiring spec sees Flagwise only from outside: the server, contracts, kernel and platform, never a service. Its scenarios live in scenarios/, not test/, so this rule covers them.',
      severity: 'error',
      from: { path: '^packages/wiring-spec/' },
      to: { path: '^(packages/modules|packages/plugin-api)/' },
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
