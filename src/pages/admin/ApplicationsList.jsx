import { useState, useEffect, useRef } from 'react'
import { adminFetch } from './AdminDashboard'
import { normalizeFinScore, computeFinalFromCiTotal, getTier, TIER_CONFIG } from './scoring'
import { getApplicantName, getInitials } from '../../lib/applicantName'
import { STATUS_CHIP } from '../../constants/pipeline'

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatCurrency(amount) {
  return '₱' + Number(amount || 0).toLocaleString()
}

function formatDate(dateStr) {
  if (!dateStr) return '—'
  return new Date(dateStr).toLocaleDateString('en-PH', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatDateShort(dateStr) {
  if (!dateStr) return '—'
  return new Date(dateStr).toLocaleDateString('en-PH', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function formatDateISO(dateStr) {
  if (!dateStr) return ''
  return new Date(dateStr).toISOString().replace('T', ' ').slice(0, 19)
}

function escapeCsvField(val) {
  const str = String(val ?? '')
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"'
  }
  return str
}

function exportConsentCsv(apps) {
  const headers = [
    'Full Name',
    'Phone Number',
    'Loan Type',
    'Reference ID',
    'Consent Timestamp',
    'Consent Status',
  ]
  const rows = apps.map(app => [
    getApplicantName(app),
    app.mobile || app.phone || '',
    (app.loan_type || '').toUpperCase(),
    app.reference_id || '',
    formatDateISO(app.submitted_at || app.created_at),
    'Agreed — Terms & Conditions and Data Privacy Policy',
  ])
  const csv = [headers, ...rows].map(row => row.map(escapeCsvField).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `gr8-consent-report-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// ---------------------------------------------------------------------------
// Skeleton loader — matches final layout shape
// ---------------------------------------------------------------------------

function TableSkeleton() {
  return (
    <div>
      <div className="x-stats mb-5">
        {[...Array(7)].map((_, i) => (
          <div key={i} className="x-stat">
            <div className="h-6 w-10 rounded bg-white/10 animate-pulse" />
            <div className="h-2.5 w-16 mt-2 rounded bg-white/10 animate-pulse" />
          </div>
        ))}
      </div>
      <div className="x-panel overflow-hidden">
        <div className="x-toolbar">
          <div className="h-10 flex-1 x-skel rounded-md animate-pulse" />
          <div className="h-10 w-36 x-skel rounded-md animate-pulse" />
          <div className="h-10 w-32 x-skel rounded-md animate-pulse" />
        </div>
        {[...Array(6)].map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-4 py-4 border-b border-border/50">
            <div className="w-8 h-8 rounded-full x-skel animate-pulse" />
            <div className="flex-1 space-y-1.5">
              <div className="h-3.5 w-40 x-skel rounded animate-pulse" />
              <div className="h-3 w-24 x-skel rounded animate-pulse" />
            </div>
            <div className="h-3 w-20 x-skel rounded animate-pulse" />
            <div className="h-5 w-16 x-skel rounded-full animate-pulse" />
            <div className="h-3 w-24 x-skel rounded animate-pulse" />
            <div className="h-3 w-20 x-skel rounded animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  )
}

function MobileCardSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      {[...Array(4)].map((_, i) => (
        <div key={i} className="x-panel p-4 space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full x-skel animate-pulse" />
            <div className="flex-1 space-y-1.5">
              <div className="h-4 w-36 x-skel rounded animate-pulse" />
              <div className="h-3 w-24 x-skel rounded animate-pulse" />
            </div>
            <div className="h-5 w-16 x-skel rounded-full animate-pulse" />
          </div>
          <div className="h-12 w-full x-skel rounded-md animate-pulse" />
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Stats tile row
// ---------------------------------------------------------------------------

function StatTiles({ apps, statusFilter, setStatusFilter }) {
  const saRejected = apps.filter(
    a => a.status === 'pending' && a.stage === 'approver' && a.sa_rejection_note,
  ).length

  const awaitingCi = apps.filter(a => a.ci_score == null && a.status === 'pending').length

  const pendingSa = apps.filter(a => a.status === 'pending_sa_confirmation').length

  const tiles = [
    { label: 'Total', count: apps.length, filter: 'all' },
    {
      label: 'Pending',
      count: apps.filter(a => a.status === 'pending').length,
      filter: 'pending',
    },
    { label: 'Awaiting CI', count: awaitingCi, filter: 'pending', sub: true, tone: 'muted' },
    {
      label: 'Awaiting SA',
      count: pendingSa,
      filter: 'pending_sa_confirmation',
      tone: 'warn',
    },
    {
      label: 'Approved',
      count: apps.filter(a => a.status === 'approved').length,
      filter: 'approved',
      tone: 'positive',
    },
    {
      label: 'Declined',
      count: apps.filter(a => a.status === 'declined').length,
      filter: 'declined',
      tone: 'negative',
    },
    { label: 'SA Rejected', count: saRejected, filter: 'sa_rejected', tone: 'negative' },
  ]

  return (
    <div className="x-stats mb-5" role="group" aria-label="Filter by status">
      {tiles.map((tile, i) => {
        // "Awaiting CI" has no dedicated status: it filters to pending and never shows active.
        const active = !tile.sub && statusFilter === tile.filter
        return (
          <button
            key={tile.label}
            onClick={() => setStatusFilter(tile.filter)}
            aria-pressed={active}
            style={{ '--i': i }}
            className={`x-stat x-stagger${tile.tone ? ` x-stat--${tile.tone}` : ''}${
              active ? ' is-active' : ''
            }`}
          >
            <span className="x-stat-count">{tile.count}</span>
            <span className="x-stat-label">{tile.label}</span>
          </button>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Row helpers — shared by the desktop table and the mobile cards
// ---------------------------------------------------------------------------

function scoreOf(app) {
  const hasCi = app.ci_score != null
  const raw = Number(app.finscore_raw || app.finscore || 0)
  const norm = normalizeFinScore(raw)
  const final = hasCi ? (app.final_score ?? computeFinalFromCiTotal(norm, app.ci_score)) : null
  const tier = final != null ? app.tier || getTier(final) : null
  const tierCfg = tier ? TIER_CONFIG[tier] || TIER_CONFIG.declined : null
  return { hasCi, raw, final, tierCfg }
}

function statusOf(app) {
  return STATUS_CHIP[app.status] || { label: app.status || 'Pending', tone: 'x-chip--neutral' }
}

function isSaRejected(app) {
  return !!app.sa_rejection_note && app.status === 'pending'
}

function ScoreCell({ app }) {
  const { raw, final, tierCfg } = scoreOf(app)
  if (final == null) {
    if (!raw) return <span className="text-muted">—</span>
    return (
      <div>
        <p className="x-num text-white text-sm leading-tight">FS {raw}</p>
        <p className="text-muted text-xs mt-0.5">Awaiting CI</p>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-3">
      <div>
        <p className="x-num text-white font-medium leading-tight">
          {final}
          <span className="text-muted text-xs font-normal"> / 100</span>
        </p>
        <div className={`x-scorebar mt-1.5 ${tierCfg.chipClass}`} aria-hidden="true">
          <span style={{ width: `${Math.min(100, Math.max(0, Number(final)))}%` }} />
        </div>
      </div>
      <span className={`x-chip ${tierCfg.chipClass}`}>{tierCfg.label}</span>
    </div>
  )
}

function StatusCell({ app }) {
  const status = statusOf(app)
  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex flex-wrap gap-1">
        <span className={`x-chip ${status.tone}`}>{status.label}</span>
        {isSaRejected(app) && <span className="x-chip x-chip--negative">SA Rejected</span>}
      </div>
      <span className="text-muted text-xs">{app.ci_score != null ? 'CI done' : 'Awaiting CI'}</span>
    </div>
  )
}

function Chevron() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      className="x-row-chevron"
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
    </svg>
  )
}

function NoResults({ onClear }) {
  return (
    <div className="py-16 text-center">
      <div className="w-12 h-12 rounded-full bg-surface-alt flex items-center justify-center mx-auto mb-3">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="w-6 h-6 text-muted"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
          />
        </svg>
      </div>
      <p className="text-white font-medium mb-1">No results</p>
      <p className="text-muted text-sm mb-4">No applications match the current filters.</p>
      <button onClick={onClear} className="x-pill">
        Clear filters
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function ApplicationsList({ onReview, onDataRefreshed }) {
  const [apps, setApps] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [statusFilter, setStatusFilter] = useState('all')
  const [typeFilter, setTypeFilter] = useState('all')
  const [soFilter, setSoFilter] = useState('all')
  const [search, setSearch] = useState('')
  const intervalRef = useRef(null)

  const fetchApps = async () => {
    try {
      const res = await adminFetch('/applications')
      if (!res.ok) throw new Error('Failed to fetch applications')
      const data = await res.json()
      const list = Array.isArray(data) ? data : data.applications || []
      setApps(list)
      setError(null)
      if (onDataRefreshed) onDataRefreshed(Date.now())
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchApps()
    intervalRef.current = setInterval(fetchApps, 30000)
    return () => clearInterval(intervalRef.current)
  }, [])

  // Unique SO names for filter dropdown
  const soNames = [...new Set(apps.map(a => a.assigned_sales_officer_name).filter(Boolean))].sort()

  const filtered = apps.filter(app => {
    if (statusFilter === 'sa_rejected') {
      if (!(app.status === 'pending' && app.stage === 'approver' && app.sa_rejection_note))
        return false
    } else if (statusFilter !== 'all' && app.status !== statusFilter) return false
    if (typeFilter !== 'all' && app.loan_type !== typeFilter) return false
    if (soFilter !== 'all') {
      if (soFilter === 'none' && app.assigned_sales_officer_name) return false
      if (soFilter !== 'none' && app.assigned_sales_officer_name !== soFilter) return false
    }
    if (search) {
      const q = search.toLowerCase()
      const name = getApplicantName(app).toLowerCase()
      const phone = (app.mobile || app.phone || '').toLowerCase()
      const so = (app.assigned_sales_officer_name || '').toLowerCase()
      if (
        !name.includes(q) &&
        !phone.includes(q) &&
        !(app.reference_id || '').toLowerCase().includes(q) &&
        !so.includes(q)
      )
        return false
    }
    return true
  })

  const activeFilterCount = [
    statusFilter !== 'all',
    typeFilter !== 'all',
    soFilter !== 'all',
    search.length > 0,
  ].filter(Boolean).length

  const clearFilters = () => {
    setStatusFilter('all')
    setTypeFilter('all')
    setSoFilter('all')
    setSearch('')
  }

  // -------------------------------------------------------------------------
  // Loading state
  // -------------------------------------------------------------------------
  if (loading) {
    return (
      <div>
        <div className="hidden lg:block">
          <TableSkeleton />
        </div>
        <div className="lg:hidden">
          <MobileCardSkeleton />
        </div>
      </div>
    )
  }

  // -------------------------------------------------------------------------
  // Error state
  // -------------------------------------------------------------------------
  if (error) {
    return (
      <div className="x-panel p-12 text-center">
        <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-4">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="w-6 h-6 text-red-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
            />
          </svg>
        </div>
        <p className="text-white font-medium mb-1">Failed to load applications</p>
        <p className="text-muted text-sm mb-5">{error}</p>
        <button
          onClick={fetchApps}
          className="inline-flex items-center gap-2 px-4 py-2 bg-green/8 hover:bg-green/15 text-green rounded-lg text-sm font-medium transition-colors"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"
            />
          </svg>
          Retry
        </button>
      </div>
    )
  }

  // -------------------------------------------------------------------------
  // Empty state (no apps at all, not just filtered)
  // -------------------------------------------------------------------------
  if (apps.length === 0) {
    return (
      <div className="x-panel p-16 text-center">
        <div className="w-14 h-14 rounded-xl bg-surface-alt flex items-center justify-center mx-auto mb-4">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="w-7 h-7 text-muted"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15a2.25 2.25 0 012.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25z"
            />
          </svg>
        </div>
        <p className="text-white font-semibold mb-1">No applications yet</p>
        <p className="text-muted text-sm">
          Applications will appear here once borrowers submit through the public portal.
        </p>
      </div>
    )
  }

  const countLabel =
    filtered.length === apps.length
      ? `${apps.length} application${apps.length !== 1 ? 's' : ''}`
      : `${filtered.length} of ${apps.length}`

  return (
    <div>
      {/* Status strip — each tile is a filter */}
      <StatTiles apps={apps} statusFilter={statusFilter} setStatusFilter={setStatusFilter} />

      <div className="x-panel overflow-hidden">
        {/* Toolbar */}
        <div className="x-toolbar">
          <div className="relative flex-1 min-w-[220px]">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
                />
              </svg>
            </span>
            <input
              type="text"
              placeholder="Search name, phone, ref ID, or SO…"
              aria-label="Search applications"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="x-control w-full pl-9 pr-9"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-1 top-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center rounded-md text-muted hover:text-white transition-colors"
                aria-label="Clear search"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="w-3.5 h-3.5"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path
                    fillRule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
            )}
          </div>

          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            aria-label="Status"
            className="x-control flex-1 lg:flex-none min-w-[148px]"
          >
            <option value="all">All Status</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="declined">Declined</option>
            <option value="withdrawn">Withdrawn</option>
            <option value="pending_sa_confirmation">Pending SA Confirmation</option>
            <option value="sa_rejected">SA Rejected</option>
          </select>
          <select
            value={typeFilter}
            onChange={e => setTypeFilter(e.target.value)}
            aria-label="Loan type"
            className="x-control flex-1 lg:flex-none min-w-[124px]"
          >
            <option value="all">All Types</option>
            <option value="personal">Personal</option>
            <option value="sme">SME</option>
            <option value="akap">AKAP</option>
            <option value="group">Group</option>
            <option value="sbl">SBL</option>
          </select>
          <select
            value={soFilter}
            onChange={e => setSoFilter(e.target.value)}
            aria-label="Sales officer"
            className="x-control flex-1 lg:flex-none min-w-[160px]"
          >
            <option value="all">All Sales Officers</option>
            <option value="none">No SO Assigned</option>
            {soNames.map(name => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>

          <div className="flex items-center gap-3 lg:ml-auto">
            <span className="text-muted text-xs whitespace-nowrap" aria-live="polite">
              {countLabel}
            </span>
            {activeFilterCount > 0 && (
              <button onClick={clearFilters} className="x-pill x-pill--sm">
                Clear ({activeFilterCount})
              </button>
            )}
          </div>
        </div>

        {/* Desktop table */}
        <div className="hidden lg:block">
          {filtered.length === 0 ? (
            <NoResults onClear={clearFilters} />
          ) : (
            <div className="overflow-x-auto">
              <table className="x-table">
                <thead>
                  <tr>
                    <th>Applicant</th>
                    <th>Loan</th>
                    <th>Submitted</th>
                    <th>Status</th>
                    <th>Score</th>
                    <th>Sales Officer</th>
                    <th aria-label="Open" />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(app => {
                    const name = getApplicantName(app)
                    const phone = app.mobile || app.phone
                    const open = () => onReview(app.id || app.reference_id)
                    return (
                      <tr
                        key={app.id || app.reference_id}
                        onClick={open}
                        onKeyDown={e => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            open()
                          }
                        }}
                        tabIndex={0}
                      >
                        <td className="max-w-[280px]">
                          <div className="flex items-center gap-3 min-w-0">
                            <span className="x-avatar-sm">{getInitials(name)}</span>
                            <div className="min-w-0">
                              <p className="text-white font-medium truncate leading-tight">
                                {name || '—'}
                              </p>
                              <p className="text-muted text-xs truncate mt-0.5">
                                <span className="font-mono">{app.reference_id || '—'}</span>
                                {phone && <span> · {phone}</span>}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="whitespace-nowrap">
                          <p className="x-num text-white font-medium leading-tight">
                            {formatCurrency(app.loan_amount || app.amount)}
                          </p>
                          <p className="x-caption mt-0.5">{app.loan_type || '—'}</p>
                        </td>
                        <td className="text-muted whitespace-nowrap">
                          {formatDateShort(app.submitted_at || app.created_at)}
                        </td>
                        <td>
                          <StatusCell app={app} />
                        </td>
                        <td>
                          <ScoreCell app={app} />
                        </td>
                        <td className="whitespace-nowrap">
                          {app.assigned_sales_officer_name ? (
                            <span className="text-white">{app.assigned_sales_officer_name}</span>
                          ) : (
                            <span className="text-muted">Unassigned</span>
                          )}
                        </td>
                        <td className="w-10 text-right">
                          <Chevron />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Mobile cards — the whole card opens the application */}
      <div className="lg:hidden flex flex-col gap-3 mt-3">
        {filtered.length === 0 ? (
          <div className="x-panel">
            <NoResults onClear={clearFilters} />
          </div>
        ) : (
          filtered.map((app, i) => {
            const name = getApplicantName(app)
            const phone = app.mobile || app.phone
            const status = statusOf(app)
            const { raw, final, tierCfg } = scoreOf(app)
            return (
              <button
                key={app.id || app.reference_id}
                onClick={() => onReview(app.id || app.reference_id)}
                style={{ '--i': Math.min(i, 8) }}
                className="x-panel x-list-card x-stagger"
              >
                <div className="flex items-start gap-3">
                  <span className="x-avatar-sm">{getInitials(name)}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-white font-medium truncate leading-tight">{name || '—'}</p>
                    <p className="text-muted text-xs truncate mt-0.5">
                      <span className="font-mono">{app.reference_id || '—'}</span>
                      {phone && <span> · {phone}</span>}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <span className={`x-chip ${status.tone}`}>{status.label}</span>
                    {isSaRejected(app) && (
                      <span className="x-chip x-chip--negative">SA Rejected</span>
                    )}
                  </div>
                </div>

                <dl className="x-list-card-metrics">
                  <div>
                    <dt className="x-caption">Amount</dt>
                    <dd className="x-num text-white font-medium">
                      {formatCurrency(app.loan_amount || app.amount)}
                    </dd>
                  </div>
                  <div>
                    <dt className="x-caption">Score</dt>
                    <dd className="x-num text-white font-medium">
                      {final != null ? final : raw > 0 ? `FS ${raw}` : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt className="x-caption">Submitted</dt>
                    <dd className="text-white">
                      {formatDateShort(app.submitted_at || app.created_at)}
                    </dd>
                  </div>
                </dl>

                <div className="flex items-center gap-2 min-w-0">
                  <span className="x-caption shrink-0">{app.loan_type || '—'}</span>
                  {tierCfg && (
                    <span className={`x-chip ${tierCfg.chipClass}`}>{tierCfg.label}</span>
                  )}
                  {final == null && <span className="text-muted text-xs">Awaiting CI</span>}
                  <span className="text-muted text-xs truncate ml-auto">
                    {app.assigned_sales_officer_name || 'Unassigned'}
                  </span>
                  <Chevron />
                </div>
              </button>
            )
          })
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Export Consent Agreement                                             */}
      {/* ------------------------------------------------------------------ */}
      {filtered.length > 0 && (
        <div className="x-panel p-5 sm:p-6 mt-8">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-full bg-green/10 flex items-center justify-center shrink-0 mt-0.5">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  className="w-5 h-5 text-green"
                >
                  <path
                    d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <div>
                <h3 className="text-white font-semibold text-sm">Export Consent Agreement</h3>
                <p className="text-muted text-xs mt-1 leading-relaxed max-w-md">
                  Export applicant names, phone numbers, and consent proof for FinScore compliance
                  reporting. All applicants agreed to the Terms &amp; Conditions and Data Privacy
                  Policy upon submission.
                </p>
              </div>
            </div>
            <button onClick={() => exportConsentCsv(filtered)} className="x-pill shrink-0">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path
                  d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              Export CSV ({filtered.length})
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
