import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, Copy, Database, Mic, MicOff, RotateCcw, Sparkles, SquarePen } from 'lucide-react'
import { ErrorState, LoadingState, PageHeader } from '../components/ui.jsx'
import Markdown from '../components/Markdown.jsx'
import AssistantAction from '../components/AssistantAction.jsx'
import { useResource } from '../hooks/useResource.js'
import { useSpeechInput } from '../hooks/useSpeechInput.js'
import { ASSISTANT_BRIEF, assistantSuggestions, loadConversation, normaliseSources, saveConversation, sourcePage } from '../lib/assistant.js'
import { allowedPages } from '../navigation.js'
import { askAssistant, fetchAssistantStatus } from '../api/endpoints.js'

/** Earlier turns sent with each question, so "and last week?" makes sense. */
const CONTEXT_TURNS = 10

const VOICE_KEY = 'pollux.assistant.voice'
const VOICES = { 'ar-EG': 'ع', 'en-US': 'EN' }

function savedVoice() {
  try {
    return localStorage.getItem(VOICE_KEY) === 'en-US' ? 'en-US' : 'ar-EG'
  } catch {
    return 'ar-EG'
  }
}

/**
 * Ask Pollux HR in your own words. Answers come from the system's own data,
 * limited to what the person asking can see. The assistant reads; anything it
 * prepares - a task, a decision - waits on this page for the person to confirm.
 */
export default function AssistantPage({ session, param, navigate, onToast, onPendingChanged }) {
  const status = useResource(fetchAssistantStatus, [])
  const [messages, setMessages] = useState(() => loadConversation(session.userId))
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(null)
  const listRef = useRef(null)
  const composerRef = useRef(null)
  const enabled = Boolean(status.data?.enabled)
  const allowed = useMemo(() => allowedPages(session), [session])

  // Dictation: Egyptian Arabic or English, remembered per browser.
  const [voice, setVoice] = useState(savedVoice)
  const dictationBase = useRef('')
  const speech = useSpeechInput({
    lang: voice,
    onText: (heard) => setDraft([dictationBase.current, heard].filter(Boolean).join(' ')),
  })
  const toggleDictation = () => {
    if (speech.listening) {
      speech.stop()
      return
    }
    dictationBase.current = draft.trim()
    speech.start()
  }
  const switchVoice = () => {
    const next = voice === 'ar-EG' ? 'en-US' : 'ar-EG'
    setVoice(next)
    try {
      localStorage.setItem(VOICE_KEY, next)
    } catch {
      // Not remembered; it still switches for now.
    }
  }

  const updateAction = (messageIndex, actionIndex, action) =>
    setMessages((current) =>
      current.map((message, index) =>
        index === messageIndex ? { ...message, actions: message.actions.map((entry, position) => (position === actionIndex ? action : entry)) } : message,
      ),
    )

  useEffect(() => saveConversation(session.userId, messages), [session.userId, messages])

  useEffect(() => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [messages, busy])

  const send = useCallback(
    async (text, base) => {
      const question = text.trim()
      if (!question || busy) return
      const thread = [...base, { role: 'user', text: question }]
      setMessages(thread)
      setDraft('')
      setFailed(null)
      setBusy(true)
      try {
        const reply = await askAssistant(thread.slice(-CONTEXT_TURNS).map(({ role, text: body }) => ({ role, text: body })))
        setMessages([
          ...thread,
          { role: 'assistant', text: reply.answer, sources: reply.sources ?? [], actions: reply.actions ?? [], followUps: reply.followUps ?? [] },
        ])
      } catch (error) {
        setFailed({ error, question, base })
      } finally {
        setBusy(false)
        composerRef.current?.focus()
      }
    },
    [busy],
  )

  // Arriving with a question (from search or a "daily brief" button) asks it once.
  const asked = useRef(false)
  useEffect(() => {
    if (!param || asked.current || !enabled) return
    asked.current = true
    navigate('assistant')
    send(param === 'brief' ? ASSISTANT_BRIEF : param, messages)
  }, [param, enabled, navigate, send, messages])

  const retry = () => {
    if (!failed) return
    setMessages(failed.base)
    send(failed.question, failed.base)
  }

  const restart = () => {
    setMessages([])
    setFailed(null)
    composerRef.current?.focus()
  }

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text)
      onToast('Answer copied.')
    } catch {
      onToast('Could not copy - select the text instead.', 'error')
    }
  }

  return (
    <div className="page assistant-page">
      <PageHeader
        title="Assistant"
        description={
          status.data?.scope === 'team'
            ? 'Ask about your team’s attendance, leave, approvals and tasks - in English or Arabic.'
            : 'Ask about attendance, leave, approvals, people and tasks - in English or Arabic.'
        }
        actions={
          messages.length > 0 && (
            <button className="button button-secondary" onClick={restart} disabled={busy}>
              <SquarePen size={16} /> New conversation
            </button>
          )
        }
      />

      <section className="assistant-panel" aria-label="Conversation with the assistant">
        <div className="assistant-messages" ref={listRef} aria-live="polite">
          {status.loading && <LoadingState label="Checking the assistant…" />}
          {status.error && <ErrorState error={status.error} onRetry={status.reload} />}
          {status.data && !enabled && (
            <div className="assistant-off">
              <Sparkles size={22} aria-hidden="true" />
              <h3>The assistant is not switched on yet</h3>
              <p>
                {session.isAdmin
                  ? 'Add a Google AI key as GOOGLE_API_KEY on the API service (Render → pollux-hr-api → Environment), then reload this page.'
                  : 'Ask your administrator to add the Google AI key that switches it on.'}
              </p>
            </div>
          )}

          {enabled && messages.length === 0 && !busy && (
            <div className="assistant-welcome">
              <span className="assistant-mark" aria-hidden="true">
                <Sparkles size={22} />
              </span>
              <h3>What would you like to know?</h3>
              <p>
                Answers come from Pollux HR’s own records{status.data.scope === 'team' ? ', for you and your team' : ''}, and it does not see pay. It can
                prepare a task or a decision, but nothing changes until you confirm it.
              </p>
              <div className="assistant-suggestions">
                {assistantSuggestions(status.data.scope).map((suggestion) => (
                  <button key={suggestion} type="button" dir="auto" onClick={() => send(suggestion, [])}>
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          )}

          <ol className="assistant-thread">
            {messages.map((message, index) =>
              message.role === 'user' ? (
                <li key={index} className="assistant-question" dir="auto">
                  {message.text}
                </li>
              ) : (
                <li key={index} className="assistant-answer">
                  <span className="assistant-mark" aria-hidden="true">
                    <Sparkles size={15} />
                  </span>
                  <div>
                    <Markdown text={message.text} />
                    {message.actions?.map((action, actionIndex) => (
                      <AssistantAction
                        key={actionIndex}
                        action={action}
                        onChange={(next) => updateAction(index, actionIndex, next)}
                        navigate={navigate}
                        onToast={onToast}
                        onPendingChanged={onPendingChanged}
                      />
                    ))}
                    <div className="assistant-meta">
                      {message.sources?.length > 0 && (
                        <span className="assistant-sources" title="Where this answer came from - open to check">
                          <Database size={13} aria-hidden="true" />
                          {normaliseSources(message.sources).map((source, sourceIndex) => {
                            const page = sourcePage(source.tool, allowed)
                            return page ? (
                              <button key={sourceIndex} type="button" onClick={() => navigate(page)}>
                                {source.label}
                              </button>
                            ) : (
                              <span key={sourceIndex}>{source.label}</span>
                            )
                          })}
                        </span>
                      )}
                      <button type="button" className="icon-button" onClick={() => copy(message.text)} aria-label="Copy answer" title="Copy answer">
                        <Copy size={14} />
                      </button>
                    </div>
                    {index === messages.length - 1 && !busy && message.followUps?.length > 0 && (
                      <div className="assistant-followups" aria-label="Ask next">
                        {message.followUps.map((question) => (
                          <button key={question} type="button" dir="auto" onClick={() => send(question, messages)}>
                            {question}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </li>
              ),
            )}
            {busy && (
              <li className="assistant-answer assistant-thinking" aria-label="The assistant is looking it up">
                <span className="assistant-mark" aria-hidden="true">
                  <Sparkles size={15} />
                </span>
                <div>
                  <span className="typing-dots" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  <small>Looking it up…</small>
                </div>
              </li>
            )}
          </ol>

          {failed && (
            <div className="assistant-failed" role="alert">
              <p>{failed.error?.message || 'The assistant could not answer.'}</p>
              {failed.error?.status !== 403 && (
                <button type="button" className="button button-secondary button-sm" onClick={retry}>
                  <RotateCcw size={14} /> Try again
                </button>
              )}
            </div>
          )}
        </div>

        <form
          className="assistant-composer"
          onSubmit={(event) => {
            event.preventDefault()
            send(draft, messages)
          }}
        >
          <label className="sr-only" htmlFor="assistant-question">
            Your question
          </label>
          <textarea
            id="assistant-question"
            ref={composerRef}
            rows="1"
            dir="auto"
            value={draft}
            maxLength={4000}
            disabled={!enabled}
            placeholder={enabled ? 'Ask a question…' : 'The assistant is not switched on'}
            onChange={(event) => {
              setDraft(event.target.value)
              event.target.style.height = 'auto'
              event.target.style.height = `${Math.min(event.target.scrollHeight, 160)}px`
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                send(draft, messages)
              }
            }}
          />
          {speech.supported && enabled && (
            <span className="assistant-voice">
              <button type="button" className="assistant-voice-lang" onClick={switchVoice} aria-label={`Dictation language: ${voice === 'ar-EG' ? 'Arabic' : 'English'}. Switch`} title="Dictation language">
                {VOICES[voice]}
              </button>
              <button
                type="button"
                className={`icon-button assistant-mic ${speech.listening ? 'listening' : ''}`}
                onClick={toggleDictation}
                aria-pressed={speech.listening}
                aria-label={speech.listening ? 'Stop dictation' : 'Dictate a question'}
                title={speech.listening ? 'Stop' : 'Speak your question'}
              >
                {speech.listening ? <MicOff size={18} /> : <Mic size={18} />}
              </button>
            </span>
          )}
          <button type="submit" className="button button-primary assistant-send" disabled={!enabled || busy || !draft.trim()} aria-label="Ask">
            <ArrowUp size={18} />
          </button>
        </form>
        {speech.error && <p className="assistant-footnote assistant-voice-error">{speech.error}</p>}
        <p className="assistant-footnote">The assistant can make mistakes. Check figures that matter in Reports before acting on them.</p>
      </section>
    </div>
  )
}
