import { useState } from 'react'
import { Check, Copy, Languages, Sparkles } from '../icons.js'
import { ErrorState, LoadingState, Modal } from './ui.jsx'
import { useResource } from '../hooks/useResource.js'
import { formatDate } from '../lib/format.js'
import { fetchDocumentContent } from '../api/endpoints.js'

/**
 * Displays an issued HR letter in English or Arabic.
 *
 * The letter is stored as text rather than a rendered file, so it can be read
 * in place, copied into an email, or pasted onto letterhead - and re-rendered
 * to PDF later without regenerating it.
 */
export default function LetterModal({ documentId, onClose }) {
  const [language, setLanguage] = useState('en')
  const [copied, setCopied] = useState(false)

  const letter = useResource(() => fetchDocumentContent(documentId), [documentId], {
    enabled: Boolean(documentId),
  })

  if (!documentId) return null

  const data = letter.data
  const body = language === 'ar' ? data?.contentAr : data?.contentEn
  const hasBothLanguages = Boolean(data?.contentEn && data?.contentAr)

  const copy = async () => {
    if (!body) return
    try {
      await navigator.clipboard.writeText(body)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard access can be denied; the text is selectable either way.
    }
  }

  return (
    <Modal
      open={Boolean(documentId)}
      onClose={onClose}
      title={data?.title ?? 'Letter'}
      eyebrow={data?.issuedOn ? `Issued ${formatDate(data.issuedOn)}` : 'Issued document'}
      size="lg"
    >
      {letter.loading && <LoadingState label="Loading letter…" />}
      {letter.error && <ErrorState error={letter.error} onRetry={letter.reload} />}

      {data && (
        <div className="letter-view">
          <div className="letter-toolbar">
            {hasBothLanguages && (
              <div className="segmented-tabs compact">
                <button className={language === 'en' ? 'active' : ''} onClick={() => setLanguage('en')}>
                  <Languages size={14} /> English
                </button>
                <button className={language === 'ar' ? 'active' : ''} onClick={() => setLanguage('ar')}>
                  العربية
                </button>
              </div>
            )}
            <div className="letter-toolbar-right">
              {/* HR must always know whether a draft was machine-written before signing it. */}
              {data.isAiGenerated ? (
                <span className="ai-badge">
                  <Sparkles size={13} /> AI drafted · review before signing
                </span>
              ) : (
                <span className="privacy-chip">Standard template</span>
              )}
              <button className="button button-secondary" onClick={copy} disabled={!body}>
                {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? 'Copied' : 'Copy text'}
              </button>
            </div>
          </div>

          {body ? (
            <pre className={`letter-body ${language === 'ar' ? 'letter-body-rtl' : ''}`}>{body}</pre>
          ) : (
            <p className="muted">No letter text was stored for this document.</p>
          )}
        </div>
      )}
    </Modal>
  )
}
