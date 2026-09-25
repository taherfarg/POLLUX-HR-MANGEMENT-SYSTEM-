import { describe, expect, it } from 'vitest';
import { neutraliseFormula, toCsv, toPdf, toXlsx, type ReportDocument } from '../src/modules/reports/report.export';

const report = (rows: ReportDocument['rows']): ReportDocument => ({
  title: 'Test report',
  subtitle: '1 Sep 2026 - 30 Sep 2026',
  columns: [
    { key: 'name', label: 'Name' },
    { key: 'net', label: 'Net', type: 'money' },
    { key: 'days', label: 'Days', type: 'number' },
  ],
  rows,
  summary: [{ label: 'Net (AED)', value: '1234.50' }],
  generatedAt: new Date('2026-09-25T10:00:00.000Z'),
  generatedBy: 'hr@pollux.demo',
  companyName: 'POLLUX MOTORS FZE',
});

describe('report exports', () => {
  it('neutralises text a spreadsheet would run as a formula', () => {
    for (const dangerous of ['=1+1', '+1', '-1+1', '@SUM(A1)', '\t=1', '\r=1']) {
      expect(neutraliseFormula(dangerous).startsWith("'")).toBe(true);
    }
    expect(neutraliseFormula('Ahmed Nabil')).toBe('Ahmed Nabil');
  });

  it('quotes CSV cells and keeps negative amounts numeric', () => {
    const csv = toCsv(report([
      { name: 'Nabil, Ahmed "AN"', net: '-150.25', days: 1.5 },
      { name: '=HYPERLINK("http://x")', net: '5883.33', days: null },
    ])).toString('utf8');
    const lines = csv.replace(/^﻿/, '').trimEnd().split('\r\n');
    expect(lines[0]).toBe('Name,Net,Days');
    expect(lines[1]).toBe('"Nabil, Ahmed ""AN""",-150.25,1.5');
    expect(lines[2]).toBe(`"'=HYPERLINK(""http://x"")",5883.33,`);
  });

  it('writes a real Excel workbook and PDF', async () => {
    const rows = Array.from({ length: 80 }, (_, index) => ({ name: `Employee ${index}`, net: '1000.00', days: index }));
    const xlsx = await toXlsx(report(rows));
    expect(xlsx.subarray(0, 2).toString()).toBe('PK');
    const pdf = await toPdf(report(rows));
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    // 80 rows do not fit on one landscape page: the table continues.
    expect((pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(1);
  });
});
