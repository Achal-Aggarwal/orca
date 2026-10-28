import { isBuiltin } from 'node:module'
import { resolve } from 'node:path'
import { build, type Plugin } from 'vite'
import { POSTHOG_SDK_BUNDLE_FILENAME } from '../../src/shared/posthog-sdk-bundle'

export function createPostHogSdkBundlePlugin(): Plugin {
  return {
    name: 'orca-posthog-sdk-bundle',
    async buildStart() {
      const result = await build({
        configFile: false,
        publicDir: false,
        logLevel: 'silent',
        resolve: { conditions: ['node'] },
        build: {
          write: false,
          minify: 'oxc',
          sourcemap: 'hidden',
          target: 'es2022',
          lib: {
            entry: resolve('src/main/telemetry/posthog-sdk-bundle-entry.ts'),
            formats: ['cjs'],
            fileName: () => POSTHOG_SDK_BUNDLE_FILENAME
          },
          rollupOptions: {
            external: isBuiltin,
            output: { keepNames: true, charset: 'ascii' }
          }
        }
      })
      let emittedEntry = false
      for (const output of Array.isArray(result) ? result : [result]) {
        if (!('output' in output)) {
          continue
        }
        for (const chunk of output.output) {
          if (chunk.type === 'chunk') {
            for (const id of chunk.moduleIds) {
              this.addWatchFile(id)
            }
            emittedEntry ||= chunk.isEntry
            this.emitFile({ type: 'asset', fileName: chunk.fileName, source: chunk.code })
          } else {
            this.emitFile({ type: 'asset', fileName: chunk.fileName, source: chunk.source })
          }
        }
      }
      if (!emittedEntry) {
        throw new Error('The telemetry SDK build produced no entry')
      }
    }
  }
}
