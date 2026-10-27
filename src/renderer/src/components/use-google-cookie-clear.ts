import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { BrowserCookieImportExecutionResult } from '@/store/slices/browser/browser-slice-contract'
import { BROWSER_GOOGLE_COOKIE_CLEAR_CAPABILITY } from '../../../shared/browser-runtime-capabilities'
import { useConfirmationDialog } from './confirmation-dialog-context'
import {
  captureGoogleCookieClearTarget,
  googleCookieClearImportTarget,
  offerGoogleCookieClear,
  type GoogleCookieClearOffer
} from '@/lib/browser-google-cookie-clear'

export function useGoogleCookieClearRunner() {
  const confirm = useConfirmationDialog()
  const running = useRef(false)
  const [busy, setBusy] = useState(false)
  const offer = useCallback(
    (target: Parameters<typeof offerGoogleCookieClear>[0]) =>
      offerGoogleCookieClear(target, confirm, (action) => {
        if (running.current) {
          return
        }
        running.current = true
        setBusy(true)
        void action().finally(() => {
          running.current = false
          setBusy(false)
        })
      }),
    [confirm]
  )
  return {
    busy,
    offer,
    fromImport: (result: BrowserCookieImportExecutionResult) =>
      offer(googleCookieClearImportTarget(result))
  }
}

export function useGoogleCookieClear(hostId: ExecutionHostId, profileId: string, label?: string) {
  const runner = useGoogleCookieClearRunner()
  const { offer } = runner
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
  const generation = useRef(0)
  const [open, setOpen] = useState(false)
  const [available, setAvailable] = useState<boolean>()
  const [checking, setChecking] = useState(true)
  const [menuOffer, setMenuOffer] = useState<GoogleCookieClearOffer>()
  useEffect(() => {
    const capturedGeneration = generation
    const current = ++capturedGeneration.current
    setChecking(true)
    void captureGoogleCookieClearTarget(hostId, profileId, label, open)
      .catch(() => ({ available: false }))
      .then((next) => {
        if (generation.current !== current) {
          return
        }
        setAvailable(next.available)
        setMenuOffer(offer('target' in next ? next.target : undefined))
        setChecking(false)
      })
    return () => {
      capturedGeneration.current++
    }
  }, [profileId, label, hostId, revision, supported, open, offer])
  return {
    ...runner,
    setOpen,
    pending: available !== false && (checking || !menuOffer),
    menuAction: checking ? undefined : menuOffer?.onClick
  }
}
