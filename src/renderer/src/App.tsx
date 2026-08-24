import React, { useState } from 'react'
import {
  Key,
  Store,
  Activity,
  ArrowRight,
  Home,
  MonitorSmartphone,
  Settings,
  LogOut,
  Shield,
  Lock,
  Package,
  Truck,
  Users,
  Receipt,
  BarChart3,
  TrendingUp,
  Wallet,
  ShieldCheck,
  FileText,
  ClipboardList
} from 'lucide-react'
import { Button } from './components/ui/button'
import { Input } from './components/ui/input'
import { ProductsScreen } from './screens/ProductsScreen'
import { SuppliersScreen } from './screens/SuppliersScreen'
import { CustomersScreen } from './screens/CustomersScreen'
import { ReceivablesScreen } from './screens/ReceivablesScreen'
import { WarrantiesScreen } from './screens/WarrantiesScreen'
import { GstReturnScreen } from './screens/GstReturnScreen'
import { DayBookScreen } from './screens/DayBookScreen'
import { OrdersScreen } from './screens/OrdersScreen'
import { BillingScreen } from './screens/BillingScreen'
import { SalesScreen } from './screens/SalesScreen'
import { AnalyticsScreen } from './screens/AnalyticsScreen'
import { BackupSettings } from './components/BackupSettings'
import { ShopProfileSettings } from './components/ShopProfileSettings'
import { UserSettings } from './components/UserSettings'
import axios from 'axios'

// Always fall back to the known local port so requests never go to "undefined/..."
const LOCAL_API = (import.meta.env.VITE_LOCAL_API_URL as string) || 'https://127.0.0.1:52001'

// Steps:
// 0 = Splash (checks setup status, routes automatically)
// 1 = License entry          (first-time only)
// 2 = Shop profile setup     (first-time only)
// 3 = Login                  (every launch after setup)
// 4 = Manager Dashboard

function App(): React.JSX.Element {
  const [step, setStep] = useState(0)
  const [loading, setLoading] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')

  // Step 1 data
  const [licenseData, setLicenseData] = useState({ licenseKey: '' })

  // Step 2 data
  const [shopData, setShopData] = useState({
    branchName: '',
    shopName: '',
    location: '',
    gst: '',
    adminUsername: '',
    adminPassword: '',
    confirmPassword: '',
    cashierUsername: '',
    cashierPassword: ''
  })

  // Step 3 data
  const [loginData, setLoginData] = useState({ username: '', password: '' })

  // Dashboard state
  const [activeTab, setActiveTab] = useState('overview')
  const [authToken, setAuthToken] = useState<string | null>(
    () => localStorage.getItem('managerToken')
  )
  const [deviceId, setDeviceId] = useState<string | null>(null)
  type AuthorizedClient = {
    id: string
    friendlyName: string
    macAddress: string
    authorizedAt: string
  }
  const [devices, setDevices] = useState<AuthorizedClient[]>([])
  const [devicesLoading, setDevicesLoading] = useState(false)
  const [unpairing, setUnpairing] = useState<string | null>(null)
  const [deviceError, setDeviceError] = useState('')
  // What this server's certificate hashes to. A till pairing for the first
  // time shows the same value and asks the manager to compare — that check,
  // done by a person, is what stops something else on the network answering
  // in this server's place while a till is being set up.
  const [certFingerprint, setCertFingerprint] = useState<string | null>(null)

  React.useEffect(() => {
    window.electron.ipcRenderer
      .invoke('get-cert-fingerprint')
      .then((fp) => setCertFingerprint(typeof fp === 'string' ? fp : null))
      .catch(() => setCertFingerprint(null))
  }, [])

  type Stats = {
    todayBills: number
    todaySales: number
    totalProducts: number
    activeCustomers: number
    connectedTerminals: number
  }
  const [stats, setStats] = useState<Stats | null>(null)
  const [statsLoading, setStatsLoading] = useState(false)


  // ─── Splash: check setup status, then route ───────────────────────────────
  React.useEffect(() => {
    if (step !== 0) return
    const timer = setTimeout(async () => {
      try {
        const res = await axios.get(`${LOCAL_API}/api/v1/system/status`)
        if (res.data.setupDone) {
          setStep(3) // Already set up → go straight to Login
        } else {
          setStep(1) // Fresh install → License entry
        }
      } catch {
        setStep(1) // Server not yet ready or fresh install
      }
    }, 3000)
    return () => clearTimeout(timer)
  }, [step])

  // ─── Step 1: License activation ───────────────────────────────────────────
  const handleLicenseSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setLoading(true)
    setErrorMsg('')
    try {
      // Licensing binds to the machine, not to a network adapter — a laptop
      // with Wi-Fi and Ethernet could otherwise report a different identity
      // per boot and fail its own hardware check.
      const hardwareId = (await window.electron.ipcRenderer.invoke('get-machine-id')) as string
      await axios.post(`${LOCAL_API}/api/v1/system/save-config`, {
        licenseKey: licenseData.licenseKey,
        hardwareId,
        branchName: 'PENDING_SETUP'
      })
      setStep(2)
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        setErrorMsg(err.response?.data?.error || err.message || 'Activation Failed')
      } else {
        setErrorMsg('Activation Failed')
      }
    } finally {
      setLoading(false)
    }
  }

  // ─── Step 2: Profile setup ────────────────────────────────────────────────
  const handleShopSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (shopData.adminPassword !== shopData.confirmPassword) {
      setErrorMsg('Passwords do not match')
      return
    }
    setLoading(true)
    setErrorMsg('')
    try {
      await axios.post(`${LOCAL_API}/api/v1/system/setup-profile`, {
        branchName: shopData.branchName,
        shopName: shopData.shopName,
        location: shopData.location,
        gst: shopData.gst,
        adminUsername: shopData.adminUsername,
        adminPassword: shopData.adminPassword,
        // Optional. Without a till account the shop has to run every terminal
        // as the manager, which gives whoever stands at the counter every
        // manager right there is.
        cashierUsername: shopData.cashierUsername.trim() || undefined,
        cashierPassword: shopData.cashierPassword || undefined
      })
      // Sign the freshly-created admin in straight away. Previously this
      // jumped to the dashboard with authToken still null, so every panel
      // failed to load until the user signed out and back in.
      try {
        const loginRes = await axios.post(`${LOCAL_API}/api/v1/auth/login`, {
          username: shopData.adminUsername,
          password: shopData.adminPassword
        })
        await establishSession(loginRes.data.token)
        setStep(4)
      } catch {
        // Account exists but auto sign-in failed — send them to the login form
        // rather than a dashboard that cannot load anything.
        setStep(3)
        setErrorMsg('Setup complete. Please sign in.')
      }
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        setErrorMsg(err.response?.data?.message || err.response?.data?.error || err.message || 'Profile Setup Failed')
      } else {
        setErrorMsg('Profile Setup Failed')
      }
    } finally {
      setLoading(false)
    }
  }

  /**
   * Stores the session token and resolves this machine's device id. Used by
   * both the login screen and the end of first-run setup — without it the
   * dashboard renders with no token and every request 401s silently, which
   * looks exactly like "the data isn't updating".
   */
  const establishSession = async (token: string): Promise<void> => {
    setAuthToken(token)
    localStorage.setItem('managerToken', token)
    try {
      const devRes = await axios.get(`${LOCAL_API}/api/v1/system/self-device-id`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      setDeviceId(devRes.data.deviceId)
    } catch {
      // non-fatal — billing will show an error if attempted without deviceId
    }
  }

  // ─── Step 3: Login ────────────────────────────────────────────────────────
  const handleLogin = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setLoading(true)
    setErrorMsg('')
    try {
      const res = await axios.post(`${LOCAL_API}/api/v1/auth/login`, {
        username: loginData.username,
        password: loginData.password
      })
      await establishSession(res.data.token)
      setStep(4)
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        setErrorMsg(err.response?.data?.error || err.message || 'Login Failed')
      } else {
        setErrorMsg('Login Failed')
      }
    } finally {
      setLoading(false)
    }
  }

  const handleSignOut = (): void => {
    setAuthToken(null)
    setDeviceId(null)
    localStorage.removeItem('managerToken')
    setLoginData({ username: '', password: '' })
    setErrorMsg('')
    setActiveTab('overview')
    setDevices([])
    setStep(3)
  }

  // ─── Devices: fetch when tab is active ────────────────────────────────────
  React.useEffect(() => {
    if (activeTab !== 'devices' || step !== 4) return
    setDevicesLoading(true)
    axios
      .get(`${LOCAL_API}/api/v1/system/authorized-clients`, {
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {}
      })
      .then((res) => setDevices(res.data.clients ?? []))
      .catch(() => setDevices([]))
      .finally(() => setDevicesLoading(false))
  }, [activeTab, step, authToken])

  /**
   * Take a till off the branch.
   *
   * A licence allows a fixed number of terminals, and until now every pairing
   * was permanent — a mistyped setup, a machine that was replaced, or one that
   * left the shop went on holding a seat with no way to release it short of
   * editing the database. A till that has rung up sales keeps its row, because
   * every one of those bills names it; what it gives up is the seat.
   */
  const handleUnpair = async (device: { id: string; friendlyName: string }): Promise<void> => {
    setUnpairing(device.id)
    setDeviceError('')
    try {
      const res = await axios.delete(
        `${LOCAL_API}/api/v1/system/authorized-clients/${device.id}`,
        { headers: { Authorization: `Bearer ${authToken}` } }
      )
      if (!res.data.success) {
        setDeviceError('Could not remove that terminal.')
        return
      }
      setDevices((prev) => prev.filter((d) => d.id !== device.id))
    } catch (e) {
      const msg = (e as { response?: { data?: { message?: string } } }).response?.data?.message
      setDeviceError(msg || 'Could not reach the local server.')
    } finally {
      setUnpairing(null)
    }
  }

  // ─── Overview stats: fetch when tab is active ─────────────────────────────
  React.useEffect(() => {
    if (activeTab !== 'overview' || step !== 4 || !authToken) return
    setStatsLoading(true)
    axios
      .get(`${LOCAL_API}/api/v1/system/stats`, {
        headers: { Authorization: `Bearer ${authToken}` }
      })
      .then((res) => setStats(res.data.stats))
      .catch(() => setStats(null))
      .finally(() => setStatsLoading(false))
  }, [activeTab, step, authToken])

  // ─── Step 0: Splash ───────────────────────────────────────────────────────
  if (step === 0) {
    return (
      <div className="min-h-screen bg-zinc-950 text-white flex flex-col items-center justify-center p-6 font-sans drag-region">
        <div className="flex items-center gap-3 animate-pulse">
          <div className="w-12 h-12 rounded-xl bg-white flex items-center justify-center shadow-lg">
            <Activity className="w-8 h-8 text-black" />
          </div>
          <span className="text-4xl font-bold tracking-tight">Cashlio</span>
        </div>
        <p className="mt-4 text-zinc-400 font-medium">Initializing Local Branch Engine...</p>
      </div>
    )
  }

  // ─── Step 1: License ──────────────────────────────────────────────────────
  if (step === 1) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6 font-sans drag-region">
        <div className="relative w-full max-w-xl no-drag-region">
          <div className="text-center mb-10">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-xl bg-zinc-100 border border-zinc-200 mb-6 shadow-sm">
              <Activity className="w-8 h-8 text-zinc-900" />
            </div>
            <h1 className="text-3xl font-bold tracking-tight mb-3">System Activation</h1>
            <p className="text-muted-foreground text-base">
              Enter your license key provided by the SaaS admin.
            </p>
          </div>

          <div className="bg-card text-card-foreground border rounded-xl p-8 shadow-sm">
            {errorMsg && (
              <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-md text-red-600 text-sm font-medium">
                {errorMsg}
              </div>
            )}

            <form onSubmit={handleLicenseSubmit} className="space-y-6">
              <div>
                <label className="block text-sm font-semibold mb-1.5 ml-1">License Key</label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
                    <Key className="w-5 h-5 text-muted-foreground z-10" />
                  </div>
                  <Input
                    type="text"
                    value={licenseData.licenseKey}
                    onChange={(e) => setLicenseData({ licenseKey: e.target.value })}
                    className="pl-11 h-12"
                    placeholder="E.g. SHP-XYZ..."
                    required
                  />
                </div>
              </div>

              <Button
                type="submit"
                disabled={loading}
                className="mt-8 w-full group flex justify-center items-center gap-2 h-12 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 font-medium transition-all"
              >
                {loading ? (
                  <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <>
                    <span>Activate & Continue</span>
                    <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                  </>
                )}
              </Button>
            </form>
          </div>
        </div>
      </div>
    )
  }

  // ─── Step 2: Shop Profile ─────────────────────────────────────────────────
  if (step === 2) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6 font-sans drag-region">
        <div className="relative w-full max-w-xl no-drag-region">
          <div className="text-center mb-10">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-xl bg-zinc-100 border border-zinc-200 mb-6 shadow-sm">
              <Store className="w-8 h-8 text-zinc-900" />
            </div>
            <h1 className="text-3xl font-bold tracking-tight mb-3">Shop Profile</h1>
            <p className="text-muted-foreground text-base">
              Configure your shop details and Super Admin account.
            </p>
          </div>

          <div className="bg-card text-card-foreground border rounded-xl p-8 shadow-sm">
            {errorMsg && (
              <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-md text-red-600 text-sm font-medium">
                {errorMsg}
              </div>
            )}

            <form onSubmit={handleShopSubmit} className="space-y-6">
              <div className="space-y-4">
                <h2 className="text-sm font-bold text-zinc-900 uppercase tracking-wider mb-2">
                  Shop Details
                </h2>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-semibold mb-1.5 ml-1">Branch Name</label>
                    <Input
                      type="text"
                      value={shopData.branchName}
                      onChange={(e) => setShopData({ ...shopData, branchName: e.target.value })}
                      placeholder="e.g. Downtown Store"
                      className="h-11"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold mb-1.5 ml-1">Shop Name</label>
                    <Input
                      type="text"
                      value={shopData.shopName}
                      onChange={(e) => setShopData({ ...shopData, shopName: e.target.value })}
                      placeholder="e.g. Acme Electronics"
                      className="h-11"
                      required
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-semibold mb-1.5 ml-1">Location</label>
                    <Input
                      type="text"
                      value={shopData.location}
                      onChange={(e) => setShopData({ ...shopData, location: e.target.value })}
                      className="h-11"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold mb-1.5 ml-1">GST/Tax ID</label>
                    <Input
                      type="text"
                      value={shopData.gst}
                      onChange={(e) => setShopData({ ...shopData, gst: e.target.value })}
                      className="h-11"
                      required
                    />
                  </div>
                </div>
              </div>

              <hr className="border-border my-6" />

              <div className="space-y-4">
                <h2 className="text-sm font-bold text-zinc-900 uppercase tracking-wider mb-2">
                  Super Admin Account
                </h2>
                <div>
                  <label className="block text-sm font-semibold mb-1.5 ml-1">Admin Username</label>
                  <Input
                    type="text"
                    value={shopData.adminUsername}
                    onChange={(e) => setShopData({ ...shopData, adminUsername: e.target.value })}
                    className="h-11"
                    required
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-semibold mb-1.5 ml-1">Password</label>
                    <Input
                      type="password"
                      value={shopData.adminPassword}
                      onChange={(e) => setShopData({ ...shopData, adminPassword: e.target.value })}
                      className="h-11"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold mb-1.5 ml-1">Confirm</label>
                    <Input
                      type="password"
                      value={shopData.confirmPassword}
                      onChange={(e) =>
                        setShopData({ ...shopData, confirmPassword: e.target.value })
                      }
                      className="h-11"
                      required
                    />
                  </div>
                </div>
              </div>

              <hr className="border-border my-6" />

              <div className="space-y-4">
                <div>
                  <h2 className="text-sm font-bold text-zinc-900 uppercase tracking-wider">
                    Till Account <span className="text-zinc-400 font-medium normal-case tracking-normal">— optional</span>
                  </h2>
                  <p className="text-xs text-muted-foreground mt-1">
                    A cashier login for the billing terminals. Without one you would
                    have to sign the tills in as the manager, which gives whoever is
                    at the counter every manager right — including voiding bills and
                    changing credit limits. You can add more later in Settings.
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-semibold mb-1.5 ml-1">Cashier Username</label>
                    <Input
                      type="text"
                      value={shopData.cashierUsername}
                      onChange={(e) =>
                        setShopData({ ...shopData, cashierUsername: e.target.value.toLowerCase() })
                      }
                      placeholder="e.g. counter1"
                      className="h-11"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold mb-1.5 ml-1">Cashier Password</label>
                    <Input
                      type="password"
                      value={shopData.cashierPassword}
                      onChange={(e) => setShopData({ ...shopData, cashierPassword: e.target.value })}
                      placeholder="At least 8 characters"
                      className="h-11"
                    />
                  </div>
                </div>
              </div>

              <Button
                type="submit"
                disabled={loading}
                className="mt-8 w-full group flex justify-center items-center gap-2 h-12 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 font-medium transition-all"
              >
                {loading ? (
                  <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <>
                    <span>Complete Setup</span>
                    <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                  </>
                )}
              </Button>
            </form>
          </div>
        </div>
      </div>
    )
  }

  // ─── Step 3: Login ────────────────────────────────────────────────────────
  if (step === 3) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6 font-sans drag-region">
        <div className="relative w-full max-w-sm no-drag-region">
          <div className="text-center mb-10">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-xl bg-zinc-100 border border-zinc-200 mb-6 shadow-sm">
              <Lock className="w-8 h-8 text-zinc-900" />
            </div>
            <h1 className="text-3xl font-bold tracking-tight mb-3">Cashlio</h1>
            <p className="text-muted-foreground text-base">Sign in to your Manager account.</p>
          </div>

          <div className="bg-card text-card-foreground border rounded-xl p-8 shadow-sm">
            {errorMsg && (
              <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-md text-red-600 text-sm font-medium">
                {errorMsg}
              </div>
            )}

            <form onSubmit={handleLogin} className="space-y-5">
              <div>
                <label className="block text-sm font-semibold mb-1.5 ml-1">Username</label>
                <Input
                  type="text"
                  value={loginData.username}
                  onChange={(e) => setLoginData({ ...loginData, username: e.target.value })}
                  className="h-11"
                  placeholder="Enter your username"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-semibold mb-1.5 ml-1">Password</label>
                <Input
                  type="password"
                  value={loginData.password}
                  onChange={(e) => setLoginData({ ...loginData, password: e.target.value })}
                  className="h-11"
                  placeholder="••••••••"
                  required
                />
              </div>

              <Button
                type="submit"
                disabled={loading}
                className="w-full group flex justify-center items-center gap-2 h-12 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 font-medium transition-all"
              >
                {loading ? (
                  <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <>
                    <span>Sign In</span>
                    <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                  </>
                )}
              </Button>
            </form>
          </div>
        </div>
      </div>
    )
  }

  // ─── Step 4: Manager Dashboard ────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-background text-foreground flex font-sans drag-region">
      {/* Sidebar */}
      <div className="w-64 border-r bg-muted/30 p-4 flex flex-col h-screen sticky top-0 no-drag-region">
        <div className="flex items-center gap-3 mb-10 px-2 mt-2">
          <div className="w-8 h-8 rounded-lg bg-zinc-900 flex items-center justify-center shadow-sm">
            <Shield className="w-5 h-5 text-white" />
          </div>
          <span className="text-xl font-bold">Manager</span>
        </div>

        <nav className="flex-1 space-y-0.5">
          {(
            [
              ['overview',   <Home className="w-4 h-4" />,             'Overview'],
              ['billing',    <Receipt className="w-4 h-4" />,          'Billing'],
              ['sales',      <BarChart3 className="w-4 h-4" />,        'Sales'],
              ['analytics',  <TrendingUp className="w-4 h-4" />,       'Analytics'],
              ['products',   <Package className="w-4 h-4" />,          'Products'],
              ['suppliers',  <Truck className="w-4 h-4" />,            'Suppliers'],
              ['orders',     <ClipboardList className="w-4 h-4" />,     'Orders'],
              ['customers',  <Users className="w-4 h-4" />,            'Customers'],
              ['receivables', <Wallet className="w-4 h-4" />,           'Receivables'],
              ['warranties', <ShieldCheck className="w-4 h-4" />,        'Warranties'],
              ['dayclose',   <Wallet className="w-4 h-4" />,            'Day book'],
              ['gst',        <FileText className="w-4 h-4" />,          'GST return'],
              ['devices',    <MonitorSmartphone className="w-4 h-4" />, 'Devices'],
              ['settings',   <Settings className="w-4 h-4" />,         'Settings'],
            ] as [string, React.ReactNode, string][]
          ).map(([tab, icon, label]) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-md transition-all text-sm font-medium ${activeTab === tab ? 'bg-zinc-200 text-zinc-900' : 'text-muted-foreground hover:bg-zinc-100 hover:text-zinc-900'}`}
            >
              {icon} {label}
            </button>
          ))}
        </nav>

        <div className="mt-auto border-t pt-4">
          <button
            type="button"
            onClick={handleSignOut}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-red-50 hover:text-red-600 transition-all text-sm font-medium text-muted-foreground"
          >
            <LogOut className="w-4 h-4" /> Sign Out
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className={`flex-1 p-8 no-drag-region ${activeTab === 'billing' ? 'flex flex-col overflow-hidden' : 'overflow-y-auto'}`}>

        {/* Phase 2 screens manage their own headers */}
        {activeTab === 'products' && <ProductsScreen token={authToken} />}
        {activeTab === 'suppliers' && <SuppliersScreen token={authToken} />}
        {activeTab === 'orders' && <OrdersScreen token={authToken} />}
        {activeTab === 'customers' && <CustomersScreen token={authToken} />}
        {activeTab === 'receivables' && <ReceivablesScreen token={authToken} />}
        {activeTab === 'warranties' && <WarrantiesScreen token={authToken} />}
        {activeTab === 'gst' && <GstReturnScreen token={authToken} />}
        {activeTab === 'dayclose' && <DayBookScreen token={authToken} />}

        {/* Phase 3 billing screens */}
        {activeTab === 'billing' && (
          <BillingScreen token={authToken} deviceId={deviceId ?? ''} />
        )}
        {activeTab === 'sales' && <SalesScreen token={authToken} />}
        {activeTab === 'analytics' && <AnalyticsScreen token={authToken} />}

        {/* Overview */}
        {activeTab === 'overview' && (
          <div className="space-y-8">
            <header className="border-b pb-4">
              <h1 className="text-3xl font-bold tracking-tight">Overview</h1>
              <p className="text-muted-foreground mt-1 text-sm">Today's activity at a glance.</p>
            </header>
            {statsLoading ? (
              <div className="flex items-center gap-2 text-zinc-400 text-sm">
                <div className="w-4 h-4 border-2 border-zinc-300 border-t-zinc-600 rounded-full animate-spin" />
                Loading stats…
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-5">
                  <div className="p-6 rounded-xl bg-card border shadow-sm">
                    <p className="text-muted-foreground text-xs font-semibold uppercase tracking-wide mb-2">Bills Today</p>
                    <p className="text-4xl font-bold text-zinc-900">{stats?.todayBills ?? 0}</p>
                    <p className="text-xs text-zinc-400 mt-2">PAID bills processed</p>
                  </div>
                  <div className="p-6 rounded-xl bg-card border shadow-sm">
                    <p className="text-muted-foreground text-xs font-semibold uppercase tracking-wide mb-2">Sales Today</p>
                    <p className="text-4xl font-bold text-zinc-900">
                      ₹{stats ? new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(stats.todaySales) : '0'}
                    </p>
                    <p className="text-xs text-zinc-400 mt-2">Total revenue collected</p>
                  </div>
                  <div className="p-6 rounded-xl bg-card border shadow-sm">
                    <p className="text-muted-foreground text-xs font-semibold uppercase tracking-wide mb-2">Active Products</p>
                    <p className="text-4xl font-bold text-zinc-900">{stats?.totalProducts ?? 0}</p>
                    <p className="text-xs text-zinc-400 mt-2">In product catalog</p>
                  </div>
                  <div className="p-6 rounded-xl bg-card border shadow-sm">
                    <p className="text-muted-foreground text-xs font-semibold uppercase tracking-wide mb-2">Active Customers</p>
                    <p className="text-4xl font-bold text-zinc-900">{stats?.activeCustomers ?? 0}</p>
                    <p className="text-xs text-zinc-400 mt-2">Registered customers</p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="p-5 rounded-xl bg-zinc-50 border flex items-center gap-4 flex-1">
                    <div className="relative flex h-3 w-3 shrink-0">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
                    </div>
                    <div>
                      <p className="text-sm font-bold text-zinc-900">Local Server Online</p>
                      <p className="text-xs text-zinc-500 mt-0.5">
                        {stats?.connectedTerminals ?? 0} terminal{stats?.connectedTerminals !== 1 ? 's' : ''} paired · Port 52001
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setStats(null)
                      setStatsLoading(true)
                      axios.get(`${LOCAL_API}/api/v1/system/stats`, {
                        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {}
                      }).then((r) => setStats(r.data.stats)).catch(() => {}).finally(() => setStatsLoading(false))
                    }}
                    className="px-4 py-2 rounded-lg border text-sm font-medium text-zinc-600 hover:bg-zinc-50 transition-colors"
                  >
                    Refresh
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Devices */}
        {activeTab === 'devices' && (
          <div className="space-y-6">
            <header className="border-b pb-4">
              <h1 className="text-3xl font-bold tracking-tight">Devices</h1>
              <p className="text-muted-foreground mt-1 text-sm">Billing terminals authorized to connect to this server.</p>
            </header>
            {certFingerprint && (
              <div className="p-5 rounded-xl bg-card border shadow-sm">
                <h2 className="text-sm font-bold text-zinc-900">This server's fingerprint</h2>
                <p className="text-xs text-muted-foreground mt-1 mb-3">
                  When a new terminal is set up it shows a fingerprint and asks whether it
                  matches. Compare it with this. If they differ, stop — something else on the
                  network is answering.
                </p>
                <p className="font-mono text-xs leading-relaxed text-zinc-800 break-all bg-zinc-50 border rounded-lg p-3">
                  {certFingerprint}
                </p>
              </div>
            )}

            <div className="p-6 rounded-xl bg-card border shadow-sm min-h-[400px]">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-bold">Authorized Billing Clients</h2>
                {devicesLoading && (
                  <div className="w-4 h-4 border-2 border-zinc-300 border-t-zinc-700 rounded-full animate-spin" />
                )}
              </div>
              {deviceError && (
                <p className="text-sm text-red-600 mb-3">{deviceError}</p>
              )}
              {!devicesLoading && devices.length === 0 ? (
                <div className="flex flex-col items-center justify-center p-12 mt-10 border-2 border-dashed rounded-xl bg-zinc-50/50">
                  <MonitorSmartphone className="w-10 h-10 text-muted-foreground mb-4" />
                  <h3 className="text-sm font-bold text-zinc-900">No Terminals Connected</h3>
                  <p className="text-muted-foreground mt-1 max-w-sm text-center text-sm">
                    App C billing clients will appear here once they pair successfully.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {devices.map((device) => (
                    <div key={device.id} className="flex items-center gap-4 p-4 rounded-lg border bg-zinc-50/50">
                      <div className="w-10 h-10 rounded-lg bg-zinc-900 flex items-center justify-center shrink-0">
                        <MonitorSmartphone className="w-5 h-5 text-white" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-zinc-900 text-sm">{device.friendlyName}</p>
                        <p className="text-xs text-muted-foreground font-mono mt-0.5">{device.macAddress}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2.5 py-0.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />
                          Authorized
                        </span>
                        <p className="text-xs text-muted-foreground mt-1">
                          {new Date(device.authorizedAt).toLocaleDateString()}
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={unpairing === device.id}
                        onClick={() => handleUnpair(device)}
                        title="Remove this terminal and free its licence seat"
                        className="shrink-0 text-xs font-medium text-red-600 hover:text-red-700 hover:bg-red-50 border border-transparent hover:border-red-200 rounded-md px-2.5 py-1.5 transition-colors disabled:opacity-50"
                      >
                        {unpairing === device.id ? 'Removing…' : 'Remove'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Settings */}
        {activeTab === 'settings' && (
          <div className="space-y-6">
            <header className="border-b pb-4">
              <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
              <p className="text-muted-foreground mt-1 text-sm">Branch configuration and system information.</p>
            </header>
            <div className="grid grid-cols-2 gap-5 max-w-2xl">
              <div className="col-span-2">
                <ShopProfileSettings token={authToken} />
              </div>
              <div className="col-span-2 empty:hidden">
                <UserSettings token={authToken} />
              </div>
              <div className="p-5 rounded-xl border bg-card space-y-1 col-span-2">
                <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">Server Address</p>
                <p className="text-base font-mono font-semibold text-zinc-900">https://127.0.0.1:52001 (local) · 0.0.0.0:52001 (LAN)</p>
              </div>
              <div className="p-5 rounded-xl border bg-zinc-50 space-y-1 col-span-2">
                <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">Database</p>
                <p className="text-sm text-zinc-700">Local PostgreSQL — managed by Prisma ORM</p>
                <p className="text-xs text-zinc-400 mt-1">All data is stored locally on this machine. No cloud sync in this phase.</p>
              </div>
              <div className="col-span-2">
                <BackupSettings />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default App
