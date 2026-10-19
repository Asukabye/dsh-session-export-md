/**
 * Standalone build for the tree-out distribution of `dsh-session-export-md`.
 *
 * The package ships two artifacts:
 * - `lib/index.js` / `lib/tool.js` — the Node halves (host plugin row, and the
 *   preset-plane tool row). Every `@deepseek-ai/*` import stays external: the
 *   running dsh installation owns those module identities, and a profile install
 *   resolves them through `$DSH_HOME/profiles/node_modules`. Everything else
 *   (zod and friends) is inlined so the package needs no runtime dependencies.
 * - `lib/client.js` — the browser bundle, emitted as the loader closure factory
 *   `window.__ModuleLoader__.load({ id, factory })` with module-table externals
 *   and CSS Modules inlined by lightningcss.
 *
 * Kept deliberately free of repository-relative imports: this file must build a
 * fresh `git clone` with no dsh checkout beside it (that is what `prepare` runs
 * on install).
 */
import { readFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import type { TsdownPlugin, UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

const PACKAGE_NAME = 'dsh-session-export-md'

/**
 * Module-table specifiers the browser shell shares into the frozen table.
 * Mirrors `packages/client/web/src/platform.ts` in dsh; a value import outside
 * this list (plus the package's own `dsh.client.inject` rows) is inlined.
 */
const PLATFORM_MODULES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

/**
 * Virtual-id wrapper keeping module CSS away from tsdown's own css pipeline.
 * The suffix matters: tsdown's guard matches ids ending in `.css`, so the
 * virtual id must not.
 */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** Emit one plugin-owned style injector plus the CSS Modules class map. */
function styleInjectionModule(
  id: string,
  tagId: string,
  css: string,
  classMap: Readonly<Record<string, string>>,
): string {
  return [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
    `export default ${JSON.stringify(classMap)};`,
  ].join('\n')
}

/** Inline `.module.css` imports as hashed class maps plus one injected style tag. */
function cssModulesPlugin(id: string): TsdownPlugin {
  return {
    name: 'dsh-standalone-css-modules',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const base = importer === undefined ? source : new URL(source, `file:///${importer.replace(/\\/g, '/')}`).pathname
      const file = decodeURIComponent(base.replace(/^\/([A-Za-z]:)/, '$1'))
      return CSS_VIRTUAL_PREFIX + file + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const file = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(file)
      const source = await readFile(file)
      const { code, exports: cssExports } = transform({
        filename: file,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      for (const [local, exported] of Object.entries(cssExports ?? {}).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0)) {
        classMap[local] = exported.name
      }
      const tagId = `${id}/${file.split(/[\\/]/).pop() ?? 'style.css'}`
      return styleInjectionModule(id, tagId, code.toString(), classMap)
    },
  }
}

/** Node halves: host rows import host modules, everything else is inlined. */
const nodeConfig: UserConfig = {
  name: PACKAGE_NAME,
  entry: {
    index: 'src/index.ts',
    tool: 'src/dsh/tool-entry.ts',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  sourcemap: true,
  deps: {
    neverBundle: (specifier: string) => specifier.startsWith('@deepseek-ai/') || isBuiltin(specifier),
    alwaysBundle: (specifier: string) => !specifier.startsWith('@deepseek-ai/') && !isBuiltin(specifier),
  },
}

/** Browser half: module-table specifiers stay imports, everything else inlines. */
function clientConfig(): UserConfig {
  const isRequested = (specifier: string): boolean => PLATFORM_MODULES.has(specifier)
  return {
    name: `${PACKAGE_NAME}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    // Browser bundles inline node-idiom deps that probe these globals; a CJS
    // output cannot carry import.meta, so the substitutions are baked in.
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: isRequested,
      // A require() the module table cannot answer is a guaranteed runtime
      // throw, so the rule is the request list: requested specifiers stay
      // imports, everything else is bundled.
      alwaysBundle: (specifier: string) => !isRequested(specifier),
    },
    inputOptions: {
      resolve: {
        conditionNames: [
          (process.env.NODE_ENV ?? 'production') === 'development' ? 'development' : 'production',
          'browser', 'import', 'module', 'default',
        ],
      },
    },
    plugins: [cssModulesPlugin(PACKAGE_NAME)],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }
}

export default [nodeConfig, clientConfig()]
