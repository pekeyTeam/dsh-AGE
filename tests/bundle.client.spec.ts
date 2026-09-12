/**
 * @vitest-environment jsdom
 *
 * Loader smoke test: load the built bundle the way the harness does.
 *
 * Everything else in this suite tests source modules. This one tests the
 * *artifact*, and it is the only spec that can catch the failures that survive a
 * green build:
 *
 * - a banner whose `id` does not match the package name, which the host keys its
 *   module graph by — a mismatch is a silent load failure, not an error;
 * - a `require` of something outside the platform module table, which throws at
 *   materialisation in the browser;
 * - a module body that throws while merely being *defined*, which would take the
 *   whole client graph down rather than this one plugin.
 *
 * It needs `lib/` to exist, so `pnpm check` builds before it tests.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Where the harness serves the bundle from, and how it keys it. */
const PLUGIN_ID = 'dsh-age'

/** The module table the dsh web shell shares into every client plugin. */
const PLATFORM_MODULES: Record<string, unknown> = {
  react: await import('react'),
  'react/jsx-runtime': await import('react/jsx-runtime'),
  'react-dom': await import('react-dom'),
  'react-dom/client': await import('react-dom/client'),
}

interface Registration {
  readonly id: string
  readonly factory: (require: (specifier: string) => unknown) => Record<string, unknown>
}

/**
 * Execute the bundle with a stand-in module loader.
 *
 * @returns the registration the bundle performed.
 */
function loadBundle(): Registration {
  const source = readFileSync(resolve(process.cwd(), 'lib/client.js'), 'utf8')
  let registration: Registration | undefined
  const loader = {
    load: (entry: Registration) => {
      registration = entry
    },
  }
  // The bundle only touches `window` at load time, to register its factory.
  // Everything else — the CSS tag, the observers — lives inside the factory
  // closure and must not run until the host materialises it.
  const run = new Function('window', source) as (scope: unknown) => void
  run({ __ModuleLoader__: loader })
  if (registration === undefined) throw new Error('bundle registered no factory')
  return registration
}

/** A `require` that refuses anything outside the platform module table. */
function platformRequire(specifier: string): unknown {
  const module = PLATFORM_MODULES[specifier]
  if (module === undefined) {
    throw new Error(`client-modules: "${specifier}" is not in the platform module table`)
  }
  return module
}

describe('the built client bundle', () => {
  it('registers under the package name, which is what the host keys on', () => {
    expect(loadBundle().id).toBe(PLUGIN_ID)
  })

  it('materialises without requiring anything outside the platform table', () => {
    // A `require` of an unlisted package throws in the browser, so this asserts
    // both that the bundle resolves and that it stayed inside its contract.
    expect(() => loadBundle().factory(platformRequire)).not.toThrow()
  })

  it('exports the cordis function-plugin surface', () => {
    const exported = loadBundle().factory(platformRequire)
    expect(exported['name']).toBe(PLUGIN_ID)
    expect(exported['inject']).toEqual(['slots', 'locale'])
    expect(typeof exported['apply']).toBe('function')
  })

  it('declares no default export, which the Loader would unwrap', () => {
    // `exports.default ?? exports` is how the Loader picks the plugin, so a
    // stray default export would discard `name`, `inject` and `apply`.
    expect(loadBundle().factory(platformRequire)['default']).toBeUndefined()
  })

  it('does not touch the document merely by being loaded', () => {
    const before = document.head.innerHTML
    loadBundle()
    // CSS injection and observers belong to the factory, which the host calls
    // only when it decides to mount the plugin. Doing work at script-execution
    // time would run it for a plugin that is installed but disabled.
    expect(document.head.innerHTML).toBe(before)
  })
})

describe('the built node half', () => {
  it('exposes a callable no-op plugin', async () => {
    const host = (await import(resolve(process.cwd(), 'lib/index.js'))) as {
      name: string
      inject: readonly string[]
      apply: (ctx: unknown) => void
    }
    expect(host.name).toBe(PLUGIN_ID)
    expect(host.inject).toEqual([])
    expect(() => host.apply({})).not.toThrow()
  })
})

describe('the manifest', () => {
  it('declares the client half the way the host scans for it', () => {
    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      name: string
      exports: Record<string, unknown>
      dsh: { bundle: { patch: string }; client: { platform: string; inject: string[] } }
    }
    // All three are hard requirements, not conventions: a package without
    // `platform: "web"` is not scanned for a client half at all, and one
    // without a string `./client` export throws during the scan.
    expect(manifest.dsh.client.platform).toBe('web')
    expect(typeof manifest.exports['./client']).toBe('string')
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.name).toBe(PLUGIN_ID)
  })

  it('patches the profile under the same name it exports', () => {
    const patch = readFileSync(resolve(process.cwd(), 'cordis.patch.yml'), 'utf8')
    // Each patch entry names a package to load. A mismatch here installs
    // cleanly and then does nothing at all.
    expect(patch).toContain(`name: '${PLUGIN_ID}'`)
    expect(patch).toContain(`id: ${PLUGIN_ID}`)
  })

  it('ships lib/ and declares no prepare script', () => {
    // pnpm ≥10 refuses a git dependency's `prepare` unless it is allowlisted, so
    // the committed build output is the only thing that makes a `github:` install
    // work on the first try.
    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
      files: string[]
    }
    expect(manifest.scripts['prepare']).toBeUndefined()
    expect(manifest.files).toContain('lib')
  })
})
