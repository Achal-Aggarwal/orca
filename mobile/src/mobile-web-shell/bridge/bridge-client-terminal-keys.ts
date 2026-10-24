import type { BridgeTerminalKeyId, BridgeTerminalToolbar } from './bridge-terminal-key'

export function createBridgeClientTerminalKeys(
  publishClaim: (claimed: boolean, inputOwner?: string, toolbar?: BridgeTerminalToolbar) => void
) {
  const listeners = new Map<
    (key: BridgeTerminalKeyId) => void,
    { inputOwner?: string; toolbar?: BridgeTerminalToolbar }
  >()
  const publish = () => {
    const owner = [...listeners.values()].at(-1)
    publishClaim(listeners.size > 0, owner?.inputOwner, owner?.toolbar)
  }
  return {
    accept: (key: BridgeTerminalKeyId, inputOwner?: string) => {
      for (const [listener, owner] of listeners) {
        if (owner.inputOwner === inputOwner) {
          listener(key)
        }
      }
    },
    claim: (
      listener: (key: BridgeTerminalKeyId) => void,
      inputOwner?: string,
      toolbar?: BridgeTerminalToolbar
    ) => {
      const entry = (key: BridgeTerminalKeyId) => listener(key)
      listeners.set(entry, { inputOwner, toolbar })
      publish()
      const release = () => {
        if (listeners.delete(entry)) {
          publish()
        }
      }
      return Object.assign(release, {
        updateToolbar: (nextToolbar?: BridgeTerminalToolbar) => {
          const owner = listeners.get(entry)
          if (owner && owner.toolbar !== nextToolbar) {
            owner.toolbar = nextToolbar
            publish()
          }
        }
      })
    },
    reassert: () => {
      if (listeners.size > 0) {
        publish()
      }
    }
  }
}
