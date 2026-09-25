import { Palmtree } from 'lucide-react'
import { EmptyMini } from './ui.jsx'
import { formatDays } from '../lib/format.js'

/**
 * Leave balances as cards: what is available, and how it was arrived at -
 * entitlement plus carried over, minus used, minus pending.
 */
export function BalanceCards({ balances, limit }) {
  const items = (balances ?? []).map(normalise)
  if (!items.length) {
    return <EmptyMini icon={Palmtree} title="No leave balances yet" text="HR sets up balances at the start of each year." />
  }
  // Annual leave first: it is the number people mean by "days left".
  items.sort((a, b) => (a.code === 'ANNUAL' ? -1 : b.code === 'ANNUAL' ? 1 : a.name.localeCompare(b.name)))
  return (
    <div className="balance-cards">
      {items.slice(0, limit ?? items.length).map((balance) => {
        const total = balance.entitled + balance.carried
        const usedShare = total > 0 ? Math.min(100, ((balance.used + balance.pending) / total) * 100) : 0
        return (
          <article className="balance-card" key={balance.id}>
            <header>
              <i className="chip-dot" style={{ background: balance.color }} />
              {balance.name}
              {!balance.isPaid && <span className="chip">Unpaid</span>}
            </header>
            <div className="available">
              {formatNumber(balance.available)}
              <small>available</small>
            </div>
            <div className="progress" aria-hidden="true">
              <span style={{ width: `${usedShare}%`, background: balance.color }} />
            </div>
            <dl>
              <div>
                <dt>Entitlement</dt>
                <dd>{formatNumber(balance.entitled)}</dd>
              </div>
              <div>
                <dt>Carried</dt>
                <dd>{formatNumber(balance.carried)}</dd>
              </div>
              <div>
                <dt>Used</dt>
                <dd>{formatNumber(balance.used)}</dd>
              </div>
              <div>
                <dt>Pending</dt>
                <dd>{formatNumber(balance.pending)}</dd>
              </div>
            </dl>
          </article>
        )
      })}
    </div>
  )
}

/** Accepts both the self-service shape and the raw API shape. */
function normalise(raw) {
  const leaveType = raw.leaveType ?? {}
  return {
    id: raw.id,
    code: raw.code ?? leaveType.code,
    name: raw.name ?? leaveType.name ?? 'Leave',
    color: raw.color ?? leaveType.colorHex ?? '#64748b',
    isPaid: raw.isPaid ?? leaveType.isPaid ?? true,
    entitled: Number(raw.entitledDays ?? 0),
    carried: Number(raw.carriedOverDays ?? 0),
    used: Number(raw.usedDays ?? raw.used ?? 0),
    pending: Number(raw.pendingDays ?? raw.pending ?? 0),
    available: Number(raw.availableDays ?? raw.available ?? 0),
  }
}

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

export { formatDays }
