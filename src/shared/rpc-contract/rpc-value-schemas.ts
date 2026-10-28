import { z } from 'zod'

export const RpcString = z.string()
export const RpcNumber = z.number()
export const RpcBoolean = z.boolean()
export const RpcUnknown = z.unknown()
export const RpcUndefined = z.undefined()
export const RpcNull = z.null()

export const RpcNullableNumber = RpcNumber.nullable()
export const RpcNullableString = RpcString.nullable()
export const RpcNullishString = RpcString.nullish()
export const RpcOptionalBoolean = RpcBoolean.optional()
export const RpcOptionalNullableString = RpcString.nullable().optional()
export const RpcOptionalNumber = RpcNumber.optional()
export const RpcOptionalString = RpcString.optional()
export const RpcOptionalUnknown = RpcUnknown.optional()
