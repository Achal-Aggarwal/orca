import { join } from 'node:path'
import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { nativeChatPasteFolder } from './native-chat-paste-files'
import {
  terminalTextInputs,
  startTerminalTextInputMaintenance,
  stopTerminalTextInputMaintenance
} from './native-chat-terminal-text-inputs'
import type {
  NativeChatTerminalTextInput,
  NativeChatTerminalTextRetirement
} from '../../shared/native-chat-terminal-text-input'

export function registerTerminalTextInputHandlers(
  assertSender: (event: IpcMainInvokeEvent) => void
): void {
  ipcMain.removeHandler('clipboard:materializeTerminalTextInput')
  ipcMain.removeHandler('clipboard:retireTerminalTextInput')
  const terminalInputs = () =>
    terminalTextInputs(join(nativeChatPasteFolder(), 'terminal-text-inputs'))
  startTerminalTextInputMaintenance(terminalInputs)
  app.once?.('will-quit', stopTerminalTextInputMaintenance)
  ipcMain.handle(
    'clipboard:materializeTerminalTextInput',
    (event, input: NativeChatTerminalTextInput) => {
      assertSender(event)
      return terminalInputs().materialize(input)
    }
  )
  ipcMain.handle(
    'clipboard:retireTerminalTextInput',
    (event, input: NativeChatTerminalTextRetirement) => {
      assertSender(event)
      return terminalInputs().retire(input)
    }
  )
}
