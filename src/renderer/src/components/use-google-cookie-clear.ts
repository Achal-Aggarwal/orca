import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { BROWSER_GOOGLE_COOKIE_CLEAR_CAPABILITY } from '../../../shared/browser-runtime-capabilities'
import { useConfirmationDialog } from './confirmation-dialog-context'
import {
  captureGoogleCookieClearTarget,
  offerGoogleCookieClear
} from '@/lib/browser-google-cookie-clear'
import { translate } from '@/i18n/i18n'

export function useGoogleCookieClear(hostId: ExecutionHostId, profileId: string, label?: string) {
  const confirm = useConfirmationDialog()
  const running = useRef(false)
  const [busy, setBusy] = useState(false)
  const parsedHost = parseExecutionHostId(hostId)
  const environmentId = parsedHost?.kind === 'runtime' ? parsedHost.environmentId : null
  const revision = useAppStore((s) => {
    const environment = s.runtimeEnvironments.find((entry) => entry.id === environmentId)
    return environment?.pairingRevision ?? environment?.createdAt
  })
  const supported = useAppStore((s) =>
    environmentId
      ? s.runtimeStatusByEnvironmentId
          .get(environmentId)
          ?.status?.capabilities?.includes(BROWSER_GOOGLE_COOKIE_CLEAR_CAPABILITY) === true
      : false
  )
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    let disposed = false
    setAvailable(false)
    void captureGoogleCookieClearTarget(hostId, profileId, label, false)
      .catch(() => ({ available: false }))
      .then((next) => {
        if (!disposed) {
          setAvailable(next.available)
        }
      })
    return () => {
      disposed = true
    }
  }, [hostId, profileId, label, revision, supported])

  const onClick = async (): Promise<void> => {
    if (running.current) {
      return
    }
    running.current = true
    setBusy(true)
    try {
      const captured = await captureGoogleCookieClearTarget(hostId, profileId, label, true)
      let execution: Promise<void> | undefined
      const offer = offerGoogleCookieClear(
        'target' in captured ? captured.target : undefined,
        confirm,
        (action) => {
          execution = action()
        }
      )
      if (!offer) {
        throw new Error('Google cookie target unavailable')
      }
      offer.onClick()
      await execution
    } catch {
      toast.error(
        translate(
          'browser.googleCookieClear.unverified',
          "Couldn't check {{profile}}'s Google cookies. Try again.",
          { profile: label || (profileId === 'default' ? 'Default' : 'Browser profile') }
        )
      )
    } finally {
      running.current = false
      setBusy(false)
    }
  }
  return { available, busy, onClick }
}
