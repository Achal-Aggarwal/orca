import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { wslMoveCutoverFixture } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../__fixtures__/wsl-mover/wsl-move-journal-seeding'
import {
  claimWslMoveRun,
  isWslMoveUnderwayOnHost,
  releaseWslMoveRun
} from './wsl-move-running-moves'

let userDataPath: string

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-running-'))
})

afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('isWslMoveUnderwayOnHost', () => {
  it('is false while a run only connects, true once it journals, false again when it ends', () => {
    const running = claimWslMoveRun('Ubuntu')
    if (!running) {
      throw new Error('expected to claim the run')
    }
    try {
      // The move's own first connect may still update an outdated server.
      expect(isWslMoveUnderwayOnHost(userDataPath, 'Ubuntu')).toBe(false)
      seedWslMoveCutover(userDataPath, wslMoveCutoverFixture('m1', 'destination-staged'))
      expect(isWslMoveUnderwayOnHost(userDataPath, 'ubuntu')).toBe(true)
      expect(isWslMoveUnderwayOnHost(userDataPath, 'Debian')).toBe(false)
    } finally {
      releaseWslMoveRun('Ubuntu', running)
    }
    // A record a crash left, with no run here, does not hold the server.
    expect(isWslMoveUnderwayOnHost(userDataPath, 'Ubuntu')).toBe(false)
  })
})
