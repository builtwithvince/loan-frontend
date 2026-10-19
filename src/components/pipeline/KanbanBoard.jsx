import { useState, useEffect, useRef, useCallback } from 'react'
import {
  DndContext,
  closestCorners,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { adminFetch, pipelineFetch } from '../../pages/admin/AdminDashboard'
import { useAuth } from '../../context/AuthContext'
import { PIPELINE_STAGES } from '../../constants/pipeline'
import KanbanColumn from './KanbanColumn'
import KanbanCard from './KanbanCard'
import TransitionModal from './TransitionModal'
import ReturnModal from './ReturnModal'
import { getApplicantName } from '../../lib/applicantName'

const LOCKED_STAGES = ['loan_processing_officer', 'declined']

function groupByStage(apps) {
  const groups = {}
  for (const stage of PIPELINE_STAGES) {
    groups[stage] = []
  }
  for (const app of apps) {
    // Withdrawn is a closed end state with no lane; without this skip the
    // unknown stage would fall through into the Sales Officer lane.
    if (app.stage === 'withdrawn') continue
    const stage = app.stage || 'sales_officer'
    if (groups[stage]) {
      groups[stage].push(app)
    } else {
      groups['sales_officer'].push(app)
    }
  }
  return groups
}

export default function KanbanBoard({ searchFilter = '', typeFilter = 'all', onCardClick }) {
  const { roles, hasRole, user } = useAuth()
  const [apps, setApps] = useState([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState(null)

  // Drag state
  const [activeApp, setActiveApp] = useState(null)
  const [pendingTransition, setPendingTransition] = useState(null) // { app, fromStage, toStage }

  // Verifier / approver action state
  const [returnApp, setReturnApp] = useState(null) // app for ReturnModal
  const [soConfirmLoading, setSoConfirmLoading] = useState(null) // app id being confirmed
  const [soDecisionLoading, setSoDecisionLoading] = useState(null) // app id SO is deciding on

  const intervalRef = useRef(null)

  const fetchApps = useCallback(async () => {
    try {
      const res = await adminFetch('/applications')
      if (!res.ok) throw new Error('Failed to fetch applications')
      const data = await res.json()
      const list = Array.isArray(data) ? data : data.applications || []
      setApps(list)
      setFetchError(null)
    } catch (err) {
      setFetchError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchApps()
    intervalRef.current = setInterval(fetchApps, 30000)
    return () => clearInterval(intervalRef.current)
  }, [fetchApps])

  // Apply client-side filters
  const filteredApps = apps.filter(app => {
    // Sales-officer-only users see only their own applications
    const elevatedRoles = [
      'super_admin',
      'admin',
      'approver',
      'verifier',
      'ci_officer',
      'loan_processing_officer',
    ]
    if (hasRole('sales_officer') && !roles.some(r => elevatedRoles.includes(r)) && user?.id) {
      if (app.assigned_sales_officer !== user.id) return false
    }

    if (typeFilter !== 'all' && app.loan_type !== typeFilter) return false

    if (searchFilter) {
      const q = searchFilter.toLowerCase()
      const name = getApplicantName(app).toLowerCase()
      const phone = (app.mobile || app.phone || '').toLowerCase()
      const ref = (app.reference_id || '').toLowerCase()
      if (!name.includes(q) && !phone.includes(q) && !ref.includes(q)) return false
    }

    return true
  })

  const grouped = groupByStage(filteredApps)

  // DnD sensors — require 8px movement to start drag (prevents accidental drags on click)
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  )

  function findAppStage(appId) {
    for (const stage of PIPELINE_STAGES) {
      if (grouped[stage]?.some(a => String(a.id || a._id || a.reference_id) === String(appId))) {
        return stage
      }
    }
    return null
  }

  function handleDragStart({ active }) {
    const dragged = filteredApps.find(
      a => String(a.id || a._id || a.reference_id) === String(active.id),
    )
    setActiveApp(dragged || null)
  }

  function handleDragEnd({ active, over }) {
    setActiveApp(null)
    if (!over) return

    const fromStage = findAppStage(active.id)
    const toStage = over.id // column id === stage key

    if (!fromStage || fromStage === toStage) return

    // Locked columns — cannot drag out
    if (LOCKED_STAGES.includes(fromStage)) return
    // Locked columns — cannot drag into loan_processing_officer directly
    if (toStage === 'loan_processing_officer' && fromStage !== 'approver') return
    // Sales Officer can only advance to the Verifier — never skip ahead to
    // approver/CI/etc. Client-confirmation (→ approver) goes through the
    // Confirm/Decline buttons, not a drag.
    if (fromStage === 'sales_officer' && toStage !== 'verifier') return

    const app = filteredApps.find(
      a => String(a.id || a._id || a.reference_id) === String(active.id),
    )
    if (!app) return

    // Open transition modal — don't commit yet
    setPendingTransition({ app, fromStage, toStage })
  }

  function handleTransitionConfirm(updatedApp) {
    if (!pendingTransition) return
    const { app, toStage } = pendingTransition
    // Only optimistically update when server confirmed (updatedApp is truthy).
    // Timeout path passes null → rely solely on fetchApps to resolve state.
    if (updatedApp) {
      setApps(prev =>
        prev.map(a => {
          const id = a.id || a._id || a.reference_id
          const targetId = app.id || app._id || app.reference_id
          if (String(id) === String(targetId)) {
            return updatedApp.stage ? { ...a, ...updatedApp } : { ...a, stage: toStage }
          }
          return a
        }),
      )
    }
    setPendingTransition(null)
    // Re-fetch from server to ensure consistency with backend
    fetchApps()
  }

  function handleTransitionCancel() {
    // Simply close modal — no state change, card snaps back automatically
    setPendingTransition(null)
  }

  function handleVerifierAction(app, action) {
    if (action === 'approve') {
      setPendingTransition({ app, fromStage: 'verifier', toStage: 'ci_officer' })
    } else if (action === 'return') {
      setReturnApp(app)
    } else if (action === 'decline') {
      setPendingTransition({ app, fromStage: 'verifier', toStage: 'declined' })
    }
  }

  async function handleRequestSOConfirmation(app) {
    const appId = app.id || app._id
    setSoConfirmLoading(appId)
    try {
      const res = await pipelineFetch(`/${appId}/so-confirmation`, {
        method: 'POST',
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.message || 'Failed to send confirmation')
      }
      setApps(prev =>
        prev.map(a => {
          if (String(a.id || a._id) === String(appId)) {
            return { ...a, so_confirmation_sent_at: new Date().toISOString() }
          }
          return a
        }),
      )
    } catch (err) {
      alert(err.message)
    } finally {
      setSoConfirmLoading(null)
    }
  }

  function handleReturnConfirm(updatedApp) {
    if (!returnApp) return
    setApps(prev =>
      prev.map(a => {
        if (String(a.id || a._id) === String(returnApp.id || returnApp._id)) {
          return updatedApp?.stage
            ? { ...a, ...updatedApp }
            : {
                ...a,
                stage: 'sales_officer',
                last_returned_at: new Date().toISOString(),
                returned_count: (a.returned_count || 0) + 1,
              }
        }
        return a
      }),
    )
    setReturnApp(null)
    fetchApps()
  }

  // SO endorses a new lead, or re-endorses a reworked app — both advance to the verifier.
  function handleSendToVerifier(app) {
    setPendingTransition({ app, fromStage: 'sales_officer', toStage: 'verifier' })
  }

  async function handleSODecision(app, decision) {
    const appId = app.id || app._id
    setSoDecisionLoading(appId)
    try {
      const res = await pipelineFetch(`/${appId}/transition`, {
        method: 'PATCH',
        body: JSON.stringify({
          to_stage: 'approver',
          meta: { so_decision: decision },
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.message || data.error || 'Failed to record decision')
      setApps(prev =>
        prev.map(a => {
          if (String(a.id || a._id) === String(appId)) {
            return data?.stage
              ? { ...a, ...data }
              : {
                  ...a,
                  stage: 'approver',
                  so_decision: decision,
                  so_decision_at: new Date().toISOString(),
                }
          }
          return a
        }),
      )
      fetchApps()
    } catch (err) {
      alert(err.message)
    } finally {
      setSoDecisionLoading(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-8 h-8 border-2 border-green border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (fetchError) {
    return (
      <div className="text-center py-20">
        <p className="text-red-400 mb-4">{fetchError}</p>
        <button
          onClick={fetchApps}
          className="text-green hover:text-green-hover text-sm transition-colors"
        >
          Retry
        </button>
      </div>
    )
  }

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <section className="x-board" aria-label="Application pipeline">
          <header className="x-board-bar">
            <div className="min-w-0">
              <p className="x-kicker">Pipeline</p>
              <h2 className="x-board-title">Applications by stage</h2>
            </div>
            <span className="x-board-total">
              {filteredApps.length} {filteredApps.length === 1 ? 'application' : 'applications'}
            </span>
          </header>

          {/* Lanes — the 1px grid gap shows through as hairline dividers */}
          <div className="x-lanes">
            {PIPELINE_STAGES.map((stage, i) => (
              <KanbanColumn
                key={stage}
                index={i}
                stage={stage}
                cards={grouped[stage] || []}
                onCardClick={onCardClick}
                onVerifierAction={handleVerifierAction}
                onRequestSOConfirmation={handleRequestSOConfirmation}
                onSODecision={handleSODecision}
                onSendToVerifier={handleSendToVerifier}
                soDecisionLoading={soDecisionLoading}
                userRoles={roles}
              />
            ))}
          </div>
        </section>

        {/* Drag overlay — floating ghost card */}
        <DragOverlay dropAnimation={null}>
          {activeApp ? (
            <div className="rotate-2">
              <KanbanCard app={activeApp} onCardClick={() => {}} isLocked={false} />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* Transition confirmation modal */}
      {pendingTransition && (
        <TransitionModal
          fromStage={pendingTransition.fromStage}
          toStage={pendingTransition.toStage}
          application={pendingTransition.app}
          onConfirm={handleTransitionConfirm}
          onCancel={handleTransitionCancel}
        />
      )}

      {/* Return modal */}
      {returnApp && (
        <ReturnModal
          application={returnApp}
          onConfirm={handleReturnConfirm}
          onCancel={() => setReturnApp(null)}
        />
      )}
    </>
  )
}
