import {
  RpcNumber,
  RpcOptionalBoolean,
  RpcOptionalString,
  RpcString,
  RpcOptionalPositiveInteger
} from './rpc-value-schemas'
import { z } from 'zod'

export const WorktreeParam = z.object({ worktree: RpcOptionalString }).partial()

export const TapParams = z.object({
  x: RpcNumber.min(0).max(1),
  y: RpcNumber.min(0).max(1),
  device: RpcOptionalString,
  emulator: RpcOptionalString,
  worktree: RpcOptionalString
})

export const GesturePoint = z.object({
  edge: RpcNumber.int().min(0).max(4).optional(),
  type: z.enum(['begin', 'move', 'end']),
  x: RpcNumber.min(0).max(1),
  y: RpcNumber.min(0).max(1)
})

export const GestureParams = z.object({
  points: z.array(GesturePoint).min(2).max(64),
  device: RpcOptionalString,
  emulator: RpcOptionalString,
  worktree: RpcOptionalString
})

export const TypeParams = z.object({
  text: RpcString,
  device: RpcOptionalString,
  emulator: RpcOptionalString,
  worktree: RpcOptionalString
})

export const ButtonParams = z.object({
  name: RpcString,
  device: RpcOptionalString,
  emulator: RpcOptionalString,
  worktree: RpcOptionalString
})

export const RotateOrientation = z.enum([
  'portrait',
  'portrait_upside_down',
  'landscape_left',
  'landscape_right'
])

export const RotateParams = z.object({
  orientation: RotateOrientation,
  device: RpcOptionalString,
  emulator: RpcOptionalString,
  worktree: RpcOptionalString
})

export const ExecParams = z.object({
  command: RpcString,
  device: RpcOptionalString,
  emulator: RpcOptionalString,
  worktree: RpcOptionalString
})

export const LaunchParams = z.object({
  package: RpcString,
  activity: RpcOptionalString,
  device: RpcOptionalString,
  emulator: RpcOptionalString,
  worktree: RpcOptionalString
})

export const PermissionsParams = z
  .object({
    op: z.enum(['grant', 'revoke', 'reset']),
    package: RpcOptionalString,
    permission: RpcOptionalString,
    device: RpcOptionalString,
    emulator: RpcOptionalString,
    worktree: RpcOptionalString
  })
  .superRefine((value, ctx) => {
    if (value.op === 'reset') {
      if (value.package) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['package'],
          message: 'package is not allowed for reset'
        })
      }
      if (value.permission) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['permission'],
          message: 'permission is not allowed for reset'
        })
      }
      return
    }
    if (!value.package) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['package'],
        message: 'package is required for grant/revoke'
      })
    }
    if (!value.permission) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['permission'],
        message: 'permission is required for grant/revoke'
      })
    }
  })

export const AxParams = z.object({
  device: RpcOptionalString,
  emulator: RpcOptionalString,
  worktree: RpcOptionalString
})

export const LogcatParams = z.object({
  lines: RpcOptionalPositiveInteger,
  filters: z.array(RpcString).optional(),
  device: RpcOptionalString,
  emulator: RpcOptionalString,
  worktree: RpcOptionalString
})

export const AttachParams = z.object({
  device: RpcOptionalString,
  worktree: RpcOptionalString,
  focus: RpcOptionalBoolean
})

export const KillParams = z.object({
  device: RpcOptionalString,
  emulator: RpcOptionalString,
  worktree: RpcOptionalString
})

export const ShutdownParams = KillParams.extend({
  managedOnly: RpcOptionalBoolean
})

export const ListParams = WorktreeParam

export const EmulatorUnregisterActiveParams = z.object({ worktree: RpcOptionalString }).partial()

export const EmulatorListDevicesParams = z.object({ worktree: RpcOptionalString }).partial()

export const EmulatorAvailabilityParams = z.object({ worktree: RpcOptionalString }).partial()

export const EmulatorListSimulatorsParams = z.object({ worktree: RpcOptionalString }).partial()
