import { useState, useEffect } from 'react'
import ApplyAccessModal from './ApplyAccessModal'
import { getApplyPasscode, onApplyLocked } from '../lib/applyAccess'

/**
 * Wraps the /apply pages. Until the staff access code is verified for this tab,
 * the page renders inert behind the access pop-up. The page stays mounted, so a
 * mid-form re-lock (code changed on the backend) keeps every entry.
 * @param {{ children: React.ReactNode }} props
 */
export default function ApplyGate({ children }) {
  const [unlocked, setUnlocked] = useState(() => Boolean(getApplyPasscode()))
  const [lockReason, setLockReason] = useState(null)

  useEffect(
    () =>
      onApplyLocked(reason => {
        setLockReason(reason || null)
        setUnlocked(false)
      }),
    [],
  )

  return (
    <>
      <div inert={!unlocked}>{children}</div>
      {!unlocked && (
        <ApplyAccessModal
          reason={lockReason}
          onUnlock={() => {
            setLockReason(null)
            setUnlocked(true)
          }}
        />
      )}
    </>
  )
}
