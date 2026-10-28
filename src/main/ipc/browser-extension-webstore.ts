import { ScalarBoolean, ScalarNonemptyString } from '../../shared/scalar-value-schemas'
import { ipcMain } from 'electron'
import { z } from 'zod'
import type { BrowserExtensionWebStoreInstallResult } from '../../shared/browser-extension-webstore'
import { respondToBrowserExtensionInstallPrompt } from '../browser/extensions/browser-extension-install-prompt'
import { installBrowserExtensionFromWebStore } from '../browser/extensions/browser-extension-webstore-service'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'

const installArgs = z.object({
  profileId: ScalarNonemptyString,
  input: ScalarNonemptyString.max(2048)
})
const promptResponse = z.object({ requestId: ScalarNonemptyString, accepted: ScalarBoolean })

/** Settings "Add from Chrome Web Store" and the install prompt's answer; trusted renderer only. */
export function registerBrowserExtensionWebStoreHandlers(): void {
  ipcMain.removeHandler('browserExtensions:installFromWebStore')
  ipcMain.removeHandler('browserExtensions:respondInstallPrompt')
  ipcMain.handle(
    'browserExtensions:installFromWebStore',
    (event, args: unknown): Promise<BrowserExtensionWebStoreInstallResult> => {
      const parsed = installArgs.safeParse(args)
      if (!isTrustedBrowserRenderer(event.sender) || !parsed.success) {
        return Promise.resolve({ status: 'failed', error: 'Not allowed' })
      }
      return installBrowserExtensionFromWebStore(
        parsed.data.profileId,
        parsed.data.input,
        event.sender
      )
    }
  )
  ipcMain.handle('browserExtensions:respondInstallPrompt', (event, args: unknown): boolean => {
    const parsed = promptResponse.safeParse(args)
    if (!isTrustedBrowserRenderer(event.sender) || !parsed.success) {
      return false
    }
    return respondToBrowserExtensionInstallPrompt(event.sender, parsed.data)
  })
}
