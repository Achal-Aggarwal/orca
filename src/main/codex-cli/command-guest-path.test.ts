import { describe, expect, it } from 'vitest'
import { guestNativeCommandOptions } from './command'

const GUEST_PATH = '/home/me/.local/bin:/usr/bin:/mnt/c/Users/me/AppData/Roaming/npm:/mnt/c/Windows'

describe('guestNativeCommandOptions', () => {
  it("drops a WSL-host orcad's Windows drive entries, so a Windows npm shim never resolves", () => {
    expect(
      guestNativeCommandOptions({ pathEnv: GUEST_PATH, homePath: '/home/me' }, ['/mnt/c'])
    ).toEqual({
      pathEnv: '/home/me/.local/bin:/usr/bin',
      homePath: '/home/me'
    })
  })

  it('honours a moved automount root', () => {
    expect(guestNativeCommandOptions({ pathEnv: '/usr/bin:/win/c/npm' }, ['/win/c']).pathEnv).toBe(
      '/usr/bin'
    )
  })

  it('leaves native Linux and SSH hosts, which have no Windows drive mounts, unchanged', () => {
    const options = { pathEnv: GUEST_PATH, homePath: '/home/me' }
    expect(guestNativeCommandOptions(options, [])).toBe(options)
    expect(guestNativeCommandOptions({}, [])).toEqual({})
  })
})
