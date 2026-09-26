import { useEffect, useState } from 'react'
import { Download, ExternalLink, FileText, Plus } from 'lucide-react'
import {
  Async,
  DataTable,
  EmptyState,
  FilterSelect,
  FormError,
  FormField,
  Modal,
  PageHeader,
  Pagination,
  Panel,
  SearchInput,
  Spinner,
  StatusPill,
  humanize,
  useSubmit,
} from '../components/ui.jsx'
import LetterModal from '../components/LetterModal.jsx'
import { EmployeePicker } from '../components/EmployeePicker.jsx'
import { useDebouncedValue, useResource } from '../hooks/useResource.js'
import { downloadFile } from '../lib/download.js'
import { formatDate } from '../lib/format.js'
import { addEmployeeDocument, documentDownloadPath, fetchDocuments } from '../api/endpoints.js'

const CATEGORIES = ['CONTRACT', 'IDENTIFICATION', 'VISA_PERMIT', 'CERTIFICATE', 'LETTER', 'PAYSLIP', 'OTHER']

/**
 * The document library: HR sees everyone's (the place to chase expiring
 * visas); everyone else sees their own, minus anything HR marked confidential.
 */
export default function DocumentsPage({ session, page, onToast }) {
  const own = page === 'my-documents' || !session.isManagement
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [expiring, setExpiring] = useState(false)
  const [pageNumber, setPageNumber] = useState(1)
  const [letterId, setLetterId] = useState(null)
  const [adding, setAdding] = useState(false)
  const debounced = useDebouncedValue(query, 300)
  useEffect(() => setPageNumber(1), [debounced, category, expiring])

  const documents = useResource(
    () => fetchDocuments({ q: debounced || undefined, category: category || undefined, expiring: expiring ? 'true' : undefined, page: pageNumber, pageSize: 25 }),
    [debounced, category, expiring, pageNumber],
  )
  const summary = documents.data?.summary ?? {}

  const download = async (row) => {
    try {
      await downloadFile(documentDownloadPath(row.id))
    } catch (error) {
      onToast(error.message, 'error')
    }
  }

  return (
    <div className="page">
      <PageHeader
        title={own ? 'My documents' : 'Documents'}
        description={own ? 'Your contracts, certificates, letters and payslips.' : `${summary.expiringSoon ?? 0} expiring in the next 90 days · ${summary.expired ?? 0} expired`}
        actions={
          !own && (
            <button className="button button-primary" onClick={() => setAdding(true)}>
              <Plus size={16} /> Add document
            </button>
          )
        }
      />
      <Panel flush>
        <div className="toolbar">
          <SearchInput value={query} onChange={setQuery} placeholder={own ? 'Title' : 'Title or employee'} label="Search documents" />
          <FilterSelect label="Category" value={category} onChange={setCategory} options={[{ value: '', label: 'All categories' }, ...CATEGORIES.map((value) => ({ value, label: humanize(value) }))]} />
          <label className="check">
            <input type="checkbox" checked={expiring} onChange={(e) => setExpiring(e.target.checked)} /> Expiring or expired
          </label>
        </div>
        <Async loading={documents.loading} error={documents.error} onRetry={documents.reload} rows={6}>
          <DataTable
            caption="Documents"
            columns={[
              {
                key: 'title',
                label: 'Document',
                primary: true,
                render: (row) => (
                  <div>
                    <strong>{row.title}</strong>
                    <small>
                      {humanize(row.category)}
                      {row.isConfidential ? ' · confidential' : ''}
                    </small>
                  </div>
                ),
              },
              ...(own ? [] : [{ key: 'employee', label: 'Employee', render: (row) => row.employee.fullName }]),
              { key: 'issuedOn', label: 'Issued', render: (row) => formatDate(row.issuedOn) },
              {
                key: 'expiresOn',
                label: 'Expires',
                render: (row) =>
                  row.expiresOn ? (
                    <StatusPill
                      tone={row.isExpired ? 'danger' : row.daysUntilExpiry <= 30 ? 'danger' : row.daysUntilExpiry <= 90 ? 'warning' : 'neutral'}
                      label={row.isExpired ? `Expired ${formatDate(row.expiresOn)}` : formatDate(row.expiresOn)}
                    />
                  ) : (
                    '—'
                  ),
              },
              {
                key: 'actions',
                label: '',
                className: 'actions',
                render: (row) =>
                  row.hasStoredFile ? (
                    <button className="button button-secondary button-sm" onClick={() => download(row)}>
                      <Download size={14} /> Download
                    </button>
                  ) : row.category === 'LETTER' ? (
                    <button className="button button-secondary button-sm" onClick={() => setLetterId(row.id)}>
                      <FileText size={14} /> Read
                    </button>
                  ) : (
                    <a className="button button-ghost button-sm" href={row.fileUrl} target="_blank" rel="noreferrer">
                      <ExternalLink size={14} /> Open
                    </a>
                  ),
              },
            ]}
            rows={documents.data?.items ?? []}
            empty={<EmptyState icon={FileText} title="No documents" text="Nothing matches these filters." />}
          />
          <Pagination meta={documents.data?.meta} onPage={setPageNumber} />
        </Async>
      </Panel>
      <LetterModal documentId={letterId} onClose={() => setLetterId(null)} />
      <Modal open={adding} onClose={() => setAdding(false)} title="Add a document" eyebrow="Linked file">
        {adding && (
          <AddDocumentForm
            onCancel={() => setAdding(false)}
            onSaved={() => {
              setAdding(false)
              documents.reload()
              onToast('Document added.')
            }}
          />
        )}
      </Modal>
    </div>
  )
}

function AddDocumentForm({ onCancel, onSaved }) {
  const [form, setForm] = useState({ employeeId: '', category: 'VISA_PERMIT', title: '', fileName: '', fileUrl: '', issuedOn: '', expiresOn: '', isConfidential: false })
  const set = (key, value) => setForm((state) => ({ ...state, [key]: value }))
  const { submit, saving, error } = useSubmit(async () => {
    await addEmployeeDocument(form.employeeId, {
      category: form.category,
      title: form.title,
      fileName: form.fileName || `${form.title}.pdf`,
      fileUrl: form.fileUrl,
      issuedOn: form.issuedOn || undefined,
      expiresOn: form.expiresOn || undefined,
      isConfidential: form.isConfidential,
    })
    onSaved()
  })
  return (
    <form className="simple-form" onSubmit={submit} noValidate>
      <EmployeePicker value={form.employeeId} onChange={(value) => set('employeeId', value)} />
      <div className="two-col">
        <FormField label="Category">
          <select value={form.category} onChange={(e) => set('category', e.target.value)}>
            {CATEGORIES.filter((value) => value !== 'PAYSLIP').map((value) => (
              <option key={value} value={value}>
                {humanize(value)}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Title" error={error?.fieldError?.('title')}>
          <input value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="UAE Residence Visa" required />
        </FormField>
        <FormField label="Issued on">
          <input type="date" value={form.issuedOn} onChange={(e) => set('issuedOn', e.target.value)} />
        </FormField>
        <FormField label="Expires on" hint="Drives the expiry alerts">
          <input type="date" value={form.expiresOn} onChange={(e) => set('expiresOn', e.target.value)} />
        </FormField>
      </div>
      <FormField label="Link to the file" error={error?.fieldError?.('fileUrl')} hint="Where the file is stored (e.g. the company drive).">
        <input type="url" value={form.fileUrl} onChange={(e) => set('fileUrl', e.target.value)} placeholder="https://" required />
      </FormField>
      <label className="check">
        <input type="checkbox" checked={form.isConfidential} onChange={(e) => set('isConfidential', e.target.checked)} /> Confidential (HR only)
      </label>
      <FormError error={error} />
      <div className="form-actions">
        <button type="button" className="button button-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="button button-primary" disabled={saving}>
          {saving && <Spinner size={15} />} Add document
        </button>
      </div>
    </form>
  )
}
