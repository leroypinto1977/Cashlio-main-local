import express, { Request, Response, NextFunction } from 'express'
import cors from 'cors'
import http from 'http'
import https from 'https'
export { startSyncEventPruning, pruneSyncEvents } from './domain/syncPruning'
import { router as systemRoutes } from './routes/system'
import { router as usersRoutes } from './routes/users'
import { router as shopRoutes } from './routes/shop'
import { router as catalogueRoutes } from './routes/catalogue'
import { router as productsRoutes } from './routes/products'
import { router as customersRoutes } from './routes/customers'
import { router as billsRoutes } from './routes/bills'
import { router as paymentsRoutes } from './routes/payments'
import { router as purchaseOrdersRoutes } from './routes/purchaseOrders'
import { router as warrantiesRoutes } from './routes/warranties'
import { router as analyticsRoutes } from './routes/analytics'
import { router as overviewRoutes } from './routes/overview'
import { router as syncRoutes } from './routes/sync'

/**
 * The branch server: what the manager app and every till in the shop talk to.
 *
 * This file assembles the application and nothing else — who may connect,
 * how a request is parsed, which routers handle it, and what happens when
 * none of them do. The routes themselves live under ./routes, and the logic
 * they call lives under ./domain, where it can be exercised without a server.
 *
 * Routers are mounted in the order they were declared, which matters:
 * /purchase-orders/suggestions has to be matched before /purchase-orders/:id.
 * Each router keeps its own routes in their original order, so that ordering
 * is preserved within a file as well as between them.
 */
const app = express()



/**
 * Who may read this API from a browser.
 *
 * It answered every origin with a wildcard, which meant any web page anyone in
 * the shop happened to open — an ad frame on a phone joined to the same Wi-Fi
 * is enough — could call this server from the visitor's browser and read the
 * replies. The token lives in the till's local storage and is sent by script,
 * not by a cookie, so the page could not have stolen it directly; it could,
 * however, read every customer, every bill and every price out of a server
 * that trusted it purely for being on the network.
 *
 * The only browsers meant to reach this are the app's own windows. In a
 * packaged build those load from file:, which sends `Origin: null`; in
 * development they load from a local Vite server. Nothing else is allowed a
 * CORS header at all, which is what makes a browser refuse to hand the
 * response back to the page that asked.
 *
 * Requests with no Origin header — the apps' own main processes, curl,
 * anything that is not a browser — are unaffected. That is not a hole: those
 * clients were never subject to the same-origin policy, and every route worth
 * protecting requires a token regardless.
 */
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || origin === 'null' || origin === 'file://') return callback(null, true)
      if (LOCAL_ORIGIN.test(origin)) return callback(null, true)
      // No header, rather than an error: the request still runs for non-browser
      // callers, and a browser blocks the page from reading the answer.
      return callback(null, false)
    },
    credentials: false
  })
)
app.use(express.json({ limit: '2mb' }))

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use(systemRoutes)
app.use(usersRoutes)
app.use(shopRoutes)
app.use(catalogueRoutes)
app.use(productsRoutes)
app.use(customersRoutes)
app.use(billsRoutes)
app.use(paymentsRoutes)
app.use(purchaseOrdersRoutes)
app.use(warrantiesRoutes)
app.use(analyticsRoutes)
app.use(overviewRoutes)
app.use(syncRoutes)

/**
 * Anything that got past every route.
 *
 * Express's built-in fallbacks answer an unknown path with an HTML error
 * page, and an unhandled throw with a stack trace — the file layout of the
 * shop's server, handed to whoever asked. Neither is what a JSON API should
 * say, and a till that gets HTML where it expected JSON fails with a parse
 * error that tells the cashier nothing.
 */
app.use((req: Request, res: Response) => {
  res.status(404).json({ success: false, error: 'NOT_FOUND', path: req.path })
})

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  // The routes catch their own errors; reaching here means something threw
  // outside one — malformed JSON in the body is the usual cause. Log the
  // detail locally, tell the caller only that it failed.
  console.error('[api] unhandled error:', err?.stack ?? err)
  if (res.headersSent) return
  res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
})

// ─── Server Export ────────────────────────────────────────────────────────────

/**
 * Start the branch API.
 *
 * Given a certificate this serves HTTPS, which is how it runs in the shop:
 * everything between a till and here used to cross the Wi-Fi in plain text,
 * including the cashier's session token on every single request. Without one
 * — the test harness, and a first boot before the certificate exists — it
 * falls back to HTTP so the server still comes up rather than leaving the
 * shop with nothing.
 */
export function startExpressServer(
  port: number = parseInt(process.env.LOCAL_SERVER_PORT || '52001'),
  tls?: { cert: string; key: string }
): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = tls
      ? https.createServer({ cert: tls.cert, key: tls.key }, app)
      : http.createServer(app)

    server.listen(port, '0.0.0.0', () => {
      console.log(
        `Local ${tls ? 'HTTPS' : 'HTTP'} server running on port ${port} (all interfaces)`
      )
      resolve(port)
    })
    server.on('error', (err) => {
      console.error(`Failed to bind port ${port}:`, err)
      reject(err)
    })
  })
}
