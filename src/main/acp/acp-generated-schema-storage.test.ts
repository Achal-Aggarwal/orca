import { describe, expect, it } from 'vitest'
import {
  FileSystemCapabilitiesSchema,
  ImplementationSchema,
  TextContentSchema
} from './generated/acp-protocol.generated'

describe('generated ACP scalar storage', () => {
  it('shares scalar leaves across independently generated declarations', () => {
    expect(ImplementationSchema.shape.name).toBe(TextContentSchema.shape.text)
    expect(ImplementationSchema.shape.version).toBe(TextContentSchema.shape.text)
    expect(FileSystemCapabilitiesSchema.shape.readTextFile).toBe(
      FileSystemCapabilitiesSchema.shape.writeTextFile
    )
    expect(FileSystemCapabilitiesSchema.parse({ vendor: { enabled: true } })).toEqual({
      vendor: { enabled: true }
    })
  })
})
