import { z } from 'zod'

/** The iPhone Duo key rail: terminal keys the shell draws in a side inset strip for the page. */

/**
 * The grant a session page declares, optionally, when it takes key presses from the shell's rail
 * and drops its own row of those keys while the rail shows. An older page declares none, so the
 * shell never draws a rail for it.
 */
export const BRIDGE_TERMINAL_KEY_RAIL_GRANT = 'terminalKeyRail'

/**
 * Page to shell, a notify on that grant: a terminal and its key row are on screen, or no longer.
 * The shell draws the rail only while this holds, so it never sends keys into a hidden terminal.
 */
export const BRIDGE_TERMINAL_KEY_RAIL_CLAIM_NOTIFY = 'terminal-key-rail-claim'

/** Shell to page, a frame: one press of a key on the rail. */
export const BRIDGE_TERMINAL_KEY_FRAME = 'terminalKey'

/** The rail vocabulary declared by the optional terminalKeyRail grant. */
export const BRIDGE_TERMINAL_KEY_IDS = [
  'escape',
  'tab',
  'shiftTab',
  'arrowUp',
  'arrowDown',
  'arrowLeft',
  'arrowRight',
  'enter',
  'ctrlC',
  'paste',
  'space',
  'backspace',
  'delete',
  'ctrlD',
  'ctrlL',
  'ctrlZ',
  'ctrlR',
  'ctrlA',
  'ctrlE',
  'ctrlW',
  'ctrlU'
] as const

export const BRIDGE_TERMINAL_TOOLBAR_KEY_IDS = [
  'toggleKeyboard',
  'toggleDisplayMode',
  'toggleInputMode',
  'addCustomKey'
] as const

export const BridgeTerminalToolbarSchema = z.object({
  canSend: z.boolean(),
  canCompose: z.boolean(),
  canPaste: z.boolean(),
  keyboardVisible: z.boolean(),
  liveInputEnabled: z.boolean(),
  phoneDisplayMode: z.boolean(),
  visibleBuiltInIds: z.array(z.string()).optional(),
  directionPadEnabled: z.boolean().optional(),
  customKeys: z.array(z.object({ id: z.string().min(1), label: z.string() }))
})
export type BridgeTerminalToolbar = z.infer<typeof BridgeTerminalToolbarSchema>

export function sameTerminalKeyRailToolbar(
  a?: BridgeTerminalToolbar,
  b?: BridgeTerminalToolbar
): boolean {
  if (!a || !b) {
    return a === b
  }
  return (
    a.canSend === b.canSend &&
    a.canCompose === b.canCompose &&
    a.canPaste === b.canPaste &&
    a.keyboardVisible === b.keyboardVisible &&
    a.liveInputEnabled === b.liveInputEnabled &&
    a.phoneDisplayMode === b.phoneDisplayMode &&
    a.directionPadEnabled === b.directionPadEnabled &&
    a.visibleBuiltInIds?.length === b.visibleBuiltInIds?.length &&
    (a.visibleBuiltInIds?.every((id, index) => id === b.visibleBuiltInIds?.[index]) ?? true) &&
    a.customKeys.length === b.customKeys.length &&
    a.customKeys.every(
      (key, index) => key.id === b.customKeys[index]?.id && key.label === b.customKeys[index]?.label
    )
  )
}

export const BridgeTerminalKeyIdSchema = z.union([
  z.enum(BRIDGE_TERMINAL_KEY_IDS),
  z.enum(BRIDGE_TERMINAL_TOOLBAR_KEY_IDS),
  z.custom<`custom:${string}` | `deleteCustom:${string}`>(
    (value) => typeof value === 'string' && /^(custom|deleteCustom):.+$/.test(value)
  )
])
export type BridgeTerminalKeyId = z.infer<typeof BridgeTerminalKeyIdSchema>

/**
 * The keys the scrollable rail shows beside the page, in its order. Empty or absent while
 * no rail shows, including every moment the page holds no claim.
 */
export const BridgeTerminalKeyRailSchema = z.array(BridgeTerminalKeyIdSchema)

export type BridgeTerminalKeyRail = readonly BridgeTerminalKeyId[]

export function sameTerminalKeyRail(a: BridgeTerminalKeyRail, b: BridgeTerminalKeyRail): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index])
}
