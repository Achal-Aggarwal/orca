import { randomUUID } from 'node:crypto'

import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type {
  TerminalTabCloseRequest,
  TerminalTabCloseResponse
} from '../../shared/terminal-tab-close'
import type {
  AutomationTerminalLifecycleRequest,
  AutomationTerminalLifecycleResponse
} from '../../shared/automation-terminal-lifecycle'
import { addFanoutListener, addFanoutListeners } from '../event-listener-fanout'

const TERMINAL_TAB_CLOSE_TIMEOUT_MS = 20_000

export async function requestTerminalTabCloseFromRenderer(
  mainWindow: BrowserWindow,
  tabId: string,
  options: { localPtyTeardownOwnedExternally?: boolean; force?: boolean } = {}
): Promise<void> {
  const requestId = randomUUID()
  const request: TerminalTabCloseRequest = { requestId, tabId, ...options }
  const response = await requestWindowTransaction<TerminalTabCloseResponse>(
    mainWindow,
    'ui:terminalTabCloseRequest',
    'ui:terminalTabCloseResponse',
    request
  )
  if (response.error) {
    throw new Error(response.error)
  }
}

export function requestAutomationTerminalLifecycle(
  window: BrowserWindow,
  request: AutomationTerminalLifecycleRequest,
  signal: AbortSignal,
  valid: () => boolean
): Promise<AutomationTerminalLifecycleResponse> {
  return requestWindowTransaction(
    window,
    'automations:terminalLifecycleRequest',
    'automations:terminalLifecycleResponse',
    request,
    { signal, valid }
  )
}

function requestWindowTransaction<T extends { requestId: string }>(
  mainWindow: BrowserWindow,
  requestChannel: string,
  responseChannel: string,
  request: { requestId: string },
  options: { signal?: AbortSignal; valid?: () => boolean } = {}
): Promise<T> {
  if (mainWindow.isDestroyed()) {
    throw new Error('renderer_unavailable')
  }
  const webContents = mainWindow.webContents
  if (webContents.isDestroyed()) {
    throw new Error('renderer_unavailable')
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const releaseListeners: (() => void)[] = []
    const onRendererUnavailable = (): void => finish(new Error('renderer_unavailable'))
    const finish = (error?: Error, response?: T): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', onRendererUnavailable)
      for (const release of releaseListeners) {
        release()
      }
      if (error) {
        reject(error)
      } else {
        resolve(response!)
      }
    }
    const timeout = setTimeout(
      () => finish(new Error('terminal_tab_close_timeout')),
      TERMINAL_TAB_CLOSE_TIMEOUT_MS
    )
    const onResponse = (event: Electron.IpcMainEvent, response: T): void => {
      // Visible request IDs confer no authority; only the selected window may commit/reject its lifecycle transaction.
      if (
        event.sender !== webContents ||
        !response ||
        response.requestId !== request.requestId ||
        (options.valid && (event.senderFrame !== webContents.mainFrame || !options.valid()))
      ) {
        return
      }
      finish(undefined, response)
    }

    releaseListeners.push(addFanoutListener(ipcMain, responseChannel, onResponse))
    // Lean test windows may lack event methods.
    if (typeof mainWindow.on === 'function') {
      releaseListeners.push(addFanoutListener(mainWindow, 'closed', onRendererUnavailable))
    }
    if (typeof webContents.on === 'function') {
      releaseListeners.push(
        addFanoutListeners(webContents, ['destroyed', 'render-process-gone'], onRendererUnavailable)
      )
    }
    options.signal?.addEventListener('abort', onRendererUnavailable, { once: true })
    if (options.signal?.aborted || options.valid?.() === false) {
      onRendererUnavailable()
      return
    }
    try {
      webContents.send(requestChannel, request)
    } catch {
      finish(new Error('renderer_unavailable'))
    }
  })
}
