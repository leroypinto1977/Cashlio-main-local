import React, { useState } from 'react'
import { Key, Database, Server, User, Lock, Activity, ArrowRight } from 'lucide-react'
import { Button } from './components/ui/button'
import { Input } from './components/ui/input'
import axios from 'axios'

function App(): React.JSX.Element {
  const [loading, setLoading] = useState(false)
  const [formData, setFormData] = useState({
    licenseKey: '',
    dbHost: 'localhost',
    dbPort: '5432',
    dbUser: 'postgres',
    dbPassword: '',
    dbName: 'shopms_local'
  })

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    setFormData((prev) => ({ ...prev, [e.target.name]: e.target.value }))
  }

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setLoading(true)

    try {
      // Mock Axios call to the Admin SaaS
      const response = await axios.post('http://localhost:3000/api/v1/licenses/activate', {
        licenseKey: formData.licenseKey,
        hardwareId: 'MOCK-MAC-1234'
      })

      console.log('Activation Response:', response.data)
      alert('Phase 1: Activation Successful (Mock)!')
    } catch (err) {
      console.error('Activation Failed:', err)
      alert('Activation Failed (Mock fallback triggered or endpoint down).')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6 font-sans">
      <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-20 pointer-events-none mix-blend-overlay"></div>

      {/* Dynamic Background */}
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-blue-600/30 rounded-full blur-[120px] pointer-events-none"></div>
      <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-emerald-600/30 rounded-full blur-[120px] pointer-events-none"></div>

      <div className="relative w-full max-w-xl">
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-blue-500 to-emerald-400 mb-6 shadow-xl shadow-blue-500/20">
            <Activity className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-4xl font-bold tracking-tight mb-3">ShopMS Main Setup</h1>
          <p className="text-slate-400 text-lg">
            Enter your license key and database credentials to initialize the central system.
          </p>
        </div>

        <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800 rounded-3xl p-8 shadow-2xl">
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* License Section */}
            <div className="space-y-4">
              <h2 className="text-sm font-semibold text-emerald-400 tracking-wider uppercase mb-2 flex items-center gap-2">
                <Key className="w-4 h-4" /> License Activation
              </h2>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1.5 ml-1">
                  License Key
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
                    <Key className="w-5 h-5 text-slate-500 z-10" />
                  </div>
                  <Input
                    type="text"
                    name="licenseKey"
                    value={formData.licenseKey}
                    onChange={handleChange}
                    className="pl-11 bg-slate-800/50 border-slate-700 text-slate-100 placeholder-slate-500 focus-visible:ring-emerald-500 h-12 rounded-xl"
                    placeholder="SHP-XYZ1-ABC2-9988"
                    required
                  />
                </div>
              </div>
            </div>

            <hr className="border-slate-800 my-8" />

            {/* Database Section */}
            <div className="space-y-4">
              <h2 className="text-sm font-semibold text-blue-400 tracking-wider uppercase mb-2 flex items-center gap-2">
                <Database className="w-4 h-4" /> Local PostgreSQL Instance
              </h2>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1.5 ml-1">
                    Host
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
                      <Server className="w-5 h-5 text-slate-500 z-10" />
                    </div>
                    <Input
                      type="text"
                      name="dbHost"
                      value={formData.dbHost}
                      onChange={handleChange}
                      className="pl-11 bg-slate-800/50 border-slate-700 text-slate-100 focus-visible:ring-blue-500 h-12 rounded-xl"
                      required
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1.5 ml-1">
                    Port
                  </label>
                  <Input
                    type="text"
                    name="dbPort"
                    value={formData.dbPort}
                    onChange={handleChange}
                    className="bg-slate-800/50 border-slate-700 text-slate-100 focus-visible:ring-blue-500 h-12 rounded-xl px-4"
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1.5 ml-1">
                    Database User
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
                      <User className="w-5 h-5 text-slate-500 z-10" />
                    </div>
                    <Input
                      type="text"
                      name="dbUser"
                      value={formData.dbUser}
                      onChange={handleChange}
                      className="pl-11 bg-slate-800/50 border-slate-700 text-slate-100 focus-visible:ring-blue-500 h-12 rounded-xl"
                      required
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1.5 ml-1">
                    Password
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
                      <Lock className="w-5 h-5 text-slate-500 z-10" />
                    </div>
                    <Input
                      type="password"
                      name="dbPassword"
                      value={formData.dbPassword}
                      onChange={handleChange}
                      className="pl-11 bg-slate-800/50 border-slate-700 text-slate-100 focus-visible:ring-blue-500 h-12 rounded-xl"
                      required
                    />
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1.5 ml-1">
                  Database Name
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
                    <Database className="w-5 h-5 text-slate-500 z-10" />
                  </div>
                  <Input
                    type="text"
                    name="dbName"
                    value={formData.dbName}
                    onChange={handleChange}
                    className="pl-11 bg-slate-800/50 border-slate-700 text-slate-100 focus-visible:ring-blue-500 h-12 rounded-xl"
                    required
                  />
                </div>
              </div>
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="mt-8 w-full group relative flex justify-center items-center gap-2 h-14 rounded-xl text-white font-semibold bg-gradient-to-r from-blue-600 to-emerald-500 hover:from-blue-500 hover:to-emerald-400 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-emerald-500 focus:ring-offset-slate-900 transition-all shadow-[0_0_20px_rgba(16,185,129,0.3)] hover:shadow-[0_0_30px_rgba(16,185,129,0.5)] border-0"
            >
              {loading ? (
                <div className="w-6 h-6 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <>
                  <span className="text-lg">Activate System</span>
                  <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                </>
              )}
            </Button>
          </form>
        </div>
      </div>
    </div>
  )
}

export default App
