import { lazy, Suspense } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import Navbar from './components/Navbar'
import Footer from './components/Footer'
import ProtectedRoute from './components/ProtectedRoute'
import ApplyGate from './components/ApplyGate'
import AdminLayout from './components/AdminLayout'
import LandingPage from './pages/LandingPage'
import PersonalLoanForm from './pages/PersonalLoanForm'
import SmeLoanForm from './pages/SmeLoanForm'
import AkapLoanForm from './pages/AkapLoanForm'
import GroupLoanForm from './pages/GroupLoanForm'
import SblLoanForm from './pages/SblLoanForm'
import SelectProduct from './pages/SelectProduct'
import TermsAndConditions from './pages/TermsAndConditions'
import NotFound from './pages/NotFound'
import Login from './pages/Login'
import Unauthorized from './pages/Unauthorized'
import AdminDashboard from './pages/admin/AdminDashboard'
import UserManagement from './pages/admin/UserManagement'
import MyAccount from './pages/admin/MyAccount'
import CiPortal from './pages/ci/CiPortal'
import { ThemeProvider } from './context/ThemeContext'
import { useAuth } from './context/AuthContext'
import AccessRestricted from './components/AccessRestricted'
import AppShell from './components/AppShell'
import { useCiNav } from './pages/ci/CiPortal'
import { INSIGHT_ROLES } from './constants/roles'

// Chart pages load on demand so Recharts stays out of the main bundle.
const Dashboard = lazy(() => import('./pages/admin/Dashboard'))
const Reporting = lazy(() => import('./pages/admin/Reporting'))

// CI officers' locked Reporting page, inside the CI shell. Admins who land here
// are sent to the real page.
function CiReportingRestricted() {
  const ciNav = useCiNav()
  const { hasAnyRole } = useAuth()
  if (hasAnyRole(INSIGHT_ROLES)) return <Navigate to="/admin/reporting" replace />
  return (
    <AppShell navItems={ciNav} showTabBar={false}>
      <AccessRestricted
        feature="Reporting"
        allowedRoles={INSIGHT_ROLES}
        homePath="/ci"
        homeLabel="Assessments"
      />
    </AppShell>
  )
}

// Reporting is listed for every staff role but only admins/super admins get in;
// everyone else sees AccessRestricted (operator decision, 2026-09-30).
// [ASSUMPTION] Dashboard stays hidden (not listed) for non-admins.
function InsightGate({ feature, homePath, homeLabel, children }) {
  const { hasAnyRole } = useAuth()
  if (hasAnyRole(INSIGHT_ROLES)) return children
  return (
    <AccessRestricted
      feature={feature}
      allowedRoles={INSIGHT_ROLES}
      homePath={homePath}
      homeLabel={homeLabel}
    />
  )
}

function PageFallback() {
  return (
    <div className="flex items-center justify-center py-24">
      <div className="w-7 h-7 border-2 border-green border-t-transparent rounded-full animate-spin" />
    </div>
  )
}

function PublicLayout({ children }) {
  return (
    <div className="public-theme min-h-screen bg-canvas text-white">
      {/* Fixed watermark */}
      <div
        className="fixed inset-0 flex items-center justify-center pointer-events-none"
        style={{ zIndex: 0, opacity: 0.025 }}
      >
        <img src="/gr8logo.png" alt="" className="w-[600px] h-auto select-none" draggable={false} />
      </div>
      <div className="relative" style={{ zIndex: 1 }}>
        <Navbar />
        <main>{children}</main>
        <Footer />
      </div>
    </div>
  )
}

const ADMIN_ROLES = [
  'admin',
  'super_admin',
  'sales_officer',
  'verifier',
  'approver',
  'loan_processing_officer',
]

function App() {
  return (
    <Routes>
      {/* Auth pages — no navbar/footer */}
      <Route path="/login" element={<Login />} />
      <Route path="/unauthorized" element={<Unauthorized />} />

      {/* Admin routes — sidebar layout */}
      <Route
        path="/admin"
        element={
          <ProtectedRoute allowedRoles={ADMIN_ROLES}>
            <ThemeProvider>
              <AdminLayout>
                <AdminDashboard />
              </AdminLayout>
            </ThemeProvider>
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/users"
        element={
          <ProtectedRoute allowedRoles={['super_admin']}>
            <ThemeProvider>
              <AdminLayout>
                <UserManagement />
              </AdminLayout>
            </ThemeProvider>
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/dashboard"
        element={
          <ProtectedRoute allowedRoles={INSIGHT_ROLES}>
            <ThemeProvider>
              <AdminLayout>
                <Suspense fallback={<PageFallback />}>
                  <Dashboard />
                </Suspense>
              </AdminLayout>
            </ThemeProvider>
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/reporting"
        element={
          <ProtectedRoute allowedRoles={ADMIN_ROLES}>
            <ThemeProvider>
              <AdminLayout>
                <InsightGate feature="Reporting">
                  <Suspense fallback={<PageFallback />}>
                    <Reporting />
                  </Suspense>
                </InsightGate>
              </AdminLayout>
            </ThemeProvider>
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/account"
        element={
          <ProtectedRoute allowedRoles={ADMIN_ROLES}>
            <ThemeProvider>
              <AdminLayout>
                <MyAccount />
              </AdminLayout>
            </ThemeProvider>
          </ProtectedRoute>
        }
      />

      {/* CI officers see Reporting in their menu, locked */}
      <Route
        path="/ci/reporting"
        element={
          <ProtectedRoute allowedRoles={['ci_officer', 'admin', 'super_admin']}>
            <ThemeProvider>
              <CiReportingRestricted />
            </ThemeProvider>
          </ProtectedRoute>
        }
      />

      {/* CI route — protected, no navbar/footer */}
      <Route
        path="/ci"
        element={
          <ProtectedRoute allowedRoles={['ci_officer', 'admin', 'super_admin']}>
            <ThemeProvider>
              <CiPortal />
            </ThemeProvider>
          </ProtectedRoute>
        }
      />

      {/* Public routes — with navbar/footer/watermark */}
      <Route
        path="/"
        element={
          <PublicLayout>
            <LandingPage />
          </PublicLayout>
        }
      />
      <Route
        path="/apply"
        element={
          <PublicLayout>
            <ApplyGate>
              <SelectProduct />
            </ApplyGate>
          </PublicLayout>
        }
      />
      <Route
        path="/apply/personal"
        element={
          <PublicLayout>
            <ApplyGate>
              <PersonalLoanForm />
            </ApplyGate>
          </PublicLayout>
        }
      />
      <Route
        path="/apply/sme"
        element={
          <PublicLayout>
            <ApplyGate>
              <SmeLoanForm />
            </ApplyGate>
          </PublicLayout>
        }
      />
      <Route
        path="/apply/akap"
        element={
          <PublicLayout>
            <ApplyGate>
              <AkapLoanForm />
            </ApplyGate>
          </PublicLayout>
        }
      />
      <Route
        path="/apply/group"
        element={
          <PublicLayout>
            <ApplyGate>
              <GroupLoanForm />
            </ApplyGate>
          </PublicLayout>
        }
      />
      <Route
        path="/apply/sbl"
        element={
          <PublicLayout>
            <ApplyGate>
              <SblLoanForm />
            </ApplyGate>
          </PublicLayout>
        }
      />
      <Route
        path="/termsandconditions"
        element={
          <PublicLayout>
            <TermsAndConditions />
          </PublicLayout>
        }
      />

      {/* Catch-all — unknown URLs land on a designed 404, never a blank page */}
      <Route
        path="*"
        element={
          <PublicLayout>
            <NotFound />
          </PublicLayout>
        }
      />
    </Routes>
  )
}

export default App
