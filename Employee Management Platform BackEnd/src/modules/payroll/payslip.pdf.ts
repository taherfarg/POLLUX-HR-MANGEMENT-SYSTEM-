import PDFDocument from 'pdfkit';
import type { Money } from '../../services/money';

/**
 * Renders a payslip as a PDF.
 *
 * Everything on it comes from the payroll snapshot (PayrollRecord and its
 * items) - never from the employee's current salary - so a payslip rendered
 * today for last March shows last March exactly as it was approved.
 */

export interface PayslipLine {
  label: string;
  amount: Money;
}

export interface PayslipData {
  company: { legalName: string; addressLine: string | null; city: string; countryName: string; registrationNumber: string };
  period: { name: string; startDate: string; endDate: string; payDate: string | null; status: string };
  employee: {
    name: string;
    number: string;
    jobTitle: string;
    department: string | null;
    workLocation: string | null;
  };
  currency: string;
  earnings: PayslipLine[];
  deductions: PayslipLine[];
  grossEarnings: Money;
  totalDeductions: Money;
  netSalary: Money;
  attendance: { workingDays: number; absentDays: string; unpaidLeaveDays: string; overtimeHours: string };
  reference: string;
  generatedAt: Date;
}

/** 12345.6 -> "12,345.60", from the Decimal's own string so no float is involved. */
export function formatAmount(value: Money): string {
  const fixed = value.toFixed(2);
  const negative = fixed.startsWith('-');
  const [whole, cents] = (negative ? fixed.slice(1) : fixed).split('.') as [string, string];
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}.${cents}`;
}

const INK = '#172033';
const MUTED = '#667085';
const LINE = '#d0d5dd';
const ACCENT = '#1d4ed8';

export function renderPayslipPdf(data: PayslipData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 48,
      info: {
        Title: `Payslip ${data.period.name} - ${data.employee.name}`,
        Author: 'Pollux HR',
        Subject: `Payslip for ${data.period.name}`,
        CreationDate: data.generatedAt,
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const width = right - left;

    // --- Header --------------------------------------------------------------
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(16).text(data.company.legalName, left, 48, { width: width * 0.6 });
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(MUTED)
      .text([data.company.addressLine, `${data.company.city}, ${data.company.countryName}`].filter(Boolean).join('\n'), { width: width * 0.6 })
      .text(`Registration ${data.company.registrationNumber}`, { width: width * 0.6 });

    doc.font('Helvetica-Bold').fontSize(20).fillColor(ACCENT).text('PAYSLIP', left, 48, { width, align: 'right' });
    doc.font('Helvetica').fontSize(11).fillColor(INK).text(data.period.name, left, 74, { width, align: 'right' });

    let y = 124;
    doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).lineWidth(1).stroke();
    y += 14;

    // --- Employee block --------------------------------------------------------
    const facts: [string, string][] = [
      ['Employee', data.employee.name],
      ['Employee number', data.employee.number],
      ['Job title', data.employee.jobTitle],
      ['Department', data.employee.department ?? '-'],
      ['Work location', data.employee.workLocation ?? '-'],
      ['Pay period', `${data.period.startDate} to ${data.period.endDate}`],
      ['Pay date', data.period.payDate ?? '-'],
      ['Currency', data.currency],
    ];
    const columnWidth = width / 2;
    facts.forEach(([label, value], index) => {
      const column = index % 2;
      const row = Math.floor(index / 2);
      const x = left + column * columnWidth;
      const rowY = y + row * 30;
      doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(label.toUpperCase(), x, rowY, { width: columnWidth - 12 });
      doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(value, x, rowY + 10, { width: columnWidth - 12 });
    });
    y += Math.ceil(facts.length / 2) * 30 + 10;

    // --- Earnings and deductions --------------------------------------------------
    const table = (title: string, lines: PayslipLine[], total: Money, totalLabel: string, startY: number): number => {
      let rowY = startY;
      doc.rect(left, rowY, width, 22).fill('#eef2f7');
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(10).text(title, left + 10, rowY + 7);
      doc.text(`Amount (${data.currency})`, left, rowY + 7, { width: width - 10, align: 'right' });
      rowY += 28;
      doc.font('Helvetica').fontSize(10);
      if (lines.length === 0) {
        doc.fillColor(MUTED).text('None', left + 10, rowY);
        rowY += 18;
      }
      for (const line of lines) {
        doc.fillColor(INK).text(line.label, left + 10, rowY, { width: width * 0.7 });
        doc.text(formatAmount(line.amount), left, rowY, { width: width - 10, align: 'right' });
        rowY += 18;
      }
      doc.moveTo(left, rowY).lineTo(right, rowY).strokeColor(LINE).stroke();
      rowY += 6;
      doc.font('Helvetica-Bold').text(totalLabel, left + 10, rowY);
      doc.text(formatAmount(total), left, rowY, { width: width - 10, align: 'right' });
      return rowY + 26;
    };

    y = table('Earnings', data.earnings, data.grossEarnings, 'Gross earnings', y);
    y = table('Deductions', data.deductions, data.totalDeductions, 'Total deductions', y);

    // --- Net salary ------------------------------------------------------------
    doc.rect(left, y, width, 40).fill(ACCENT);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(13).text('NET SALARY', left + 14, y + 13);
    doc.text(`${data.currency} ${formatAmount(data.netSalary)}`, left, y + 13, { width: width - 14, align: 'right' });
    y += 58;

    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(MUTED)
      .text(
        `Working days ${data.attendance.workingDays}  ·  Absent days ${data.attendance.absentDays}  ·  Unpaid leave days ${data.attendance.unpaidLeaveDays}  ·  Overtime hours ${data.attendance.overtimeHours}`,
        left,
        y,
        { width },
      );

    // --- Footer ------------------------------------------------------------------
    const footerY = doc.page.height - doc.page.margins.bottom - 36;
    doc.moveTo(left, footerY).lineTo(right, footerY).strokeColor(LINE).stroke();
    doc
      .fontSize(8)
      .fillColor(MUTED)
      .text(
        `Generated by Pollux HR from the ${data.period.status.toLowerCase()} payroll for ${data.period.name} on ${data.generatedAt.toISOString().slice(0, 10)}. ` +
          `Reference ${data.reference}. Confidential - for the named employee only.`,
        left,
        footerY + 8,
        { width },
      );

    doc.end();
  });
}
