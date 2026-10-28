import { z } from 'zod'

export const terminalTextInputSchema = z.object({
  requestId: z.string().uuid(),
  scopeKey: z.string().min(1),
  ptyId: z.string().min(1),
  input: z.string(),
  sources: z.array(z.object({ id: z.string().uuid(), text: z.string() })).min(1)
})
export type NativeChatTerminalTextInput = z.infer<typeof terminalTextInputSchema>
export type NativeChatTerminalTextRetirement = Pick<
  NativeChatTerminalTextInput,
  'requestId' | 'scopeKey' | 'ptyId'
>
