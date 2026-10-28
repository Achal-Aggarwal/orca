import { RpcUndefined, RpcUnknown } from './rpc-value-schemas'
import { z } from 'zod'
import { MouseButton, MouseXY } from './browser-params'
import { OptionalFiniteNumber } from './rpc-param-primitives'

export const MouseModifiers = RpcUnknown.transform((v) => (Array.isArray(v) ? v : undefined))
  .pipe(z.union([z.array(z.enum(['cmd', 'ctrl', 'alt', 'shift'])), RpcUndefined]))
  .optional()

export const MouseClick = MouseXY.merge(MouseButton).extend({
  radius: OptionalFiniteNumber,
  modifiers: MouseModifiers
})
