import { Money } from './ui.jsx'
import { formatMinutes } from '../lib/format.js'

/**
 * A payroll line as a payslip: earnings, deductions, net. Everything shown
 * comes from the stored snapshot, so it matches the approved PDF exactly.
 */
export function PayslipView({ record }) {
  const items = record.items ?? []
  const earnings = items.filter((item) => item.kind === 'EARNING')
  const deductions = items.filter((item) => item.kind === 'DEDUCTION')
  const currency = record.currency

  return (
    <div>
      <div className="payslip-lines">
        <table>
          <thead>
            <tr>
              <th>Earnings</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {earnings.map((item) => (
              <tr key={item.id}>
                <td>{item.label}</td>
                <td className="num">
                  <Money value={item.amount} currency={currency} />
                </td>
              </tr>
            ))}
            {!earnings.length && (
              <tr>
                <td colSpan="2" className="muted">
                  None
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td>Gross earnings</td>
              <td className="num">
                <Money value={record.grossEarnings} currency={currency} />
              </td>
            </tr>
          </tfoot>
        </table>
        <table>
          <thead>
            <tr>
              <th>Deductions</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {deductions.map((item) => (
              <tr key={item.id}>
                <td>{item.label}</td>
                <td className="num">
                  <Money value={item.amount} currency={currency} negative />
                </td>
              </tr>
            ))}
            {!deductions.length && (
              <tr>
                <td colSpan="2" className="muted">
                  None
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td>Total deductions</td>
              <td className="num">
                <Money value={record.totalDeductions} currency={currency} negative />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="net-band">
        <span>Net salary</span>
        <strong>
          <Money value={record.netSalary} currency={currency} />
        </strong>
      </div>
      <p className="small muted" style={{ marginTop: 10 }}>
        Working days {record.workingDays} · absent {record.absentDays} · unpaid leave {record.unpaidLeaveDays} · late {formatMinutes(record.lateMinutes)} · overtime{' '}
        {formatMinutes(record.overtimeMinutes)} · daily rate {Number(record.dailyRate).toFixed(2)}
        {record.warnings?.length ? ` · ${record.warnings.join('; ')}` : ''}
      </p>
    </div>
  )
}
