import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, Check, LogOut, MessagesSquare, Send, Trash2, UserPlus, UsersRound } from 'lucide-react'
import { Avatar, ConfirmDialog, EmptyState, ErrorState, FormError, FormField, LoadingState, Modal, SearchInput, SegmentedTabs, Spinner, useSubmit } from './ui.jsx'
import { useDebouncedValue, useResource } from '../hooks/useResource.js'
import { usePolling } from '../hooks/usePolling.js'
import { changedMessages, chatPerson, latestChange, mergeMessages, threadRows } from '../lib/chat.js'
import { emitChange } from '../lib/events.js'
import { formatTime } from '../lib/format.js'
import {
  addChatMembers,
  createGroupChat,
  deleteChatMessage,
  fetchChatContacts,
  fetchConversation,
  fetchMessages,
  leaveGroupChat,
  markConversationRead,
  openDirectChat,
  renameGroupChat,
  sendChatMessage,
} from '../api/endpoints.js'

/** How often an open conversation asks for new messages. */
const THREAD_POLL_MS = 4000

export function ConversationAvatar({ conversation, size = 'md' }) {
  if (conversation.kind === 'GROUP') {
    return (
      <span className={`avatar avatar-${size} avatar-group`} aria-hidden="true">
        <UsersRound size={size === 'sm' ? 15 : 18} />
      </span>
    )
  }
  const other = conversation.members.find((member) => !member.isMe)
  return <Avatar employee={chatPerson(other ?? { id: conversation.id, fullName: conversation.title })} size={size} />
}

/** Search-and-tick list of colleagues, for a new group or for adding people. */
function PeoplePicker({ selected, onChange, exclude = [] }) {
  const [query, setQuery] = useState('')
  const debounced = useDebouncedValue(query, 250)
  const contacts = useResource(() => fetchChatContacts(debounced || undefined), [debounced])
  const people = (contacts.data ?? []).filter((person) => !exclude.includes(person.id))
  const toggle = (id) => onChange(selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id])

  return (
    <div className="people-picker">
      <SearchInput value={query} onChange={setQuery} placeholder="Search by name or job" label="Search colleagues" />
      {contacts.loading && <LoadingState rows={3} />}
      {contacts.error && <ErrorState error={contacts.error} compact />}
      {!contacts.loading && !people.length && <p className="muted people-empty">Nobody matches.</p>}
      <ul>
        {people.map((person) => (
          <li key={person.id}>
            <label className={selected.includes(person.id) ? 'selected' : ''}>
              <input type="checkbox" checked={selected.includes(person.id)} onChange={() => toggle(person.id)} />
              <Avatar employee={chatPerson(person)} size="sm" />
              <span>
                <strong>{person.fullName}</strong>
                <small>{[person.jobTitle, person.department].filter(Boolean).join(' · ') || 'Pollux Motors'}</small>
              </span>
              <i className="pick-mark" aria-hidden="true">
                <Check size={13} strokeWidth={3} />
              </i>
            </label>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Start a conversation: one person, or a named group. */
export function NewChatModal({ open, onClose, onOpened }) {
  const [mode, setMode] = useState('DIRECT')
  const [query, setQuery] = useState('')
  const [title, setTitle] = useState('')
  const [selected, setSelected] = useState([])
  const [opening, setOpening] = useState(null)
  const [error, setError] = useState(null)
  const debounced = useDebouncedValue(query, 250)
  const contacts = useResource(() => fetchChatContacts(debounced || undefined), [debounced], { enabled: open && mode === 'DIRECT' })

  useEffect(() => {
    if (open) {
      setMode('DIRECT')
      setQuery('')
      setTitle('')
      setSelected([])
      setError(null)
      setOpening(null)
    }
  }, [open])

  const startDirect = async (person) => {
    setOpening(person.id)
    setError(null)
    try {
      onOpened(await openDirectChat(person.id))
    } catch (caught) {
      setError(caught)
      setOpening(null)
    }
  }

  const group = useSubmit(async () => {
    if (title.trim().length < 2) throw new Error('Give the group a name.')
    if (!selected.length) throw new Error('Choose at least one person.')
    onOpened(await createGroupChat(title.trim(), selected))
  })

  return (
    <Modal open={open} onClose={onClose} title="New conversation" size="md">
      <div className="new-chat">
        <SegmentedTabs
          label="Conversation type"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'DIRECT', label: 'One person' },
            { value: 'GROUP', label: 'Group' },
          ]}
        />
        {mode === 'DIRECT' ? (
          <div className="people-picker">
            <SearchInput value={query} onChange={setQuery} placeholder="Search by name or job" label="Search colleagues" />
            {contacts.loading && <LoadingState rows={4} />}
            {contacts.error && <ErrorState error={contacts.error} compact />}
            <ul>
              {(contacts.data ?? []).map((person) => (
                <li key={person.id}>
                  <button type="button" onClick={() => startDirect(person)} disabled={Boolean(opening)}>
                    <Avatar employee={chatPerson(person)} size="sm" />
                    <span>
                      <strong>{person.fullName}</strong>
                      <small>{[person.jobTitle, person.department].filter(Boolean).join(' · ') || 'Pollux Motors'}</small>
                    </span>
                    {opening === person.id && <Spinner size={15} />}
                  </button>
                </li>
              ))}
            </ul>
            {!contacts.loading && !(contacts.data ?? []).length && <p className="muted people-empty">Nobody matches.</p>}
            <FormError error={error} />
          </div>
        ) : (
          <form className="simple-form" onSubmit={group.submit}>
            <FormField label="Group name">
              <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Showroom team" maxLength={80} />
            </FormField>
            <PeoplePicker selected={selected} onChange={setSelected} />
            <FormError error={group.error} />
            <div className="form-actions">
              <button type="button" className="button button-ghost" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="button button-primary" disabled={group.saving}>
                {group.saving && <Spinner size={15} />} Create group{selected.length ? ` · ${selected.length + 1} people` : ''}
              </button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  )
}

/** Members, name, adding people and leaving - for a group. */
function GroupInfoModal({ open, conversation, onClose, onChanged, onLeft, onToast }) {
  const [title, setTitle] = useState(conversation.title)
  const [adding, setAdding] = useState(false)
  const [selected, setSelected] = useState([])
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    if (open) {
      setTitle(conversation.title)
      setAdding(false)
      setSelected([])
    }
  }, [open, conversation.title])

  const rename = useSubmit(async () => {
    if (title.trim() === conversation.title) return
    await renameGroupChat(conversation.id, title.trim())
    onToast('Group renamed.')
    onChanged()
  })

  const add = useSubmit(async () => {
    if (!selected.length) throw new Error('Choose at least one person.')
    await addChatMembers(conversation.id, selected)
    onToast(`${selected.length === 1 ? 'One person' : `${selected.length} people`} added.`)
    setAdding(false)
    setSelected([])
    onChanged()
  })

  return (
    <>
      <Modal open={open && !leaving} onClose={onClose} title={conversation.title} eyebrow={`Group · ${conversation.members.length} members`}>
        <div className="group-info">
          <form className="group-rename" onSubmit={rename.submit}>
            <FormField label="Group name">
              <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={80} />
            </FormField>
            <button type="submit" className="button button-secondary" disabled={rename.saving || title.trim() === conversation.title || title.trim().length < 2}>
              {rename.saving && <Spinner size={15} />} Rename
            </button>
          </form>
          <FormError error={rename.error} />

          {adding ? (
            <form className="simple-form" onSubmit={add.submit}>
              <PeoplePicker selected={selected} onChange={setSelected} exclude={conversation.members.map((member) => member.id)} />
              <FormError error={add.error} />
              <div className="form-actions">
                <button type="button" className="button button-ghost" onClick={() => setAdding(false)}>
                  Back
                </button>
                <button type="submit" className="button button-primary" disabled={add.saving}>
                  {add.saving && <Spinner size={15} />} Add to group
                </button>
              </div>
            </form>
          ) : (
            <>
              <div className="group-members-head">
                <p className="eyebrow">Members</p>
                <button type="button" className="button button-secondary button-sm" onClick={() => setAdding(true)}>
                  <UserPlus size={15} /> Add people
                </button>
              </div>
              <ul className="group-members">
                {conversation.members.map((member) => (
                  <li key={member.id}>
                    <Avatar employee={chatPerson(member)} size="sm" />
                    <span>
                      <strong>{member.isMe ? `${member.fullName} (you)` : member.fullName}</strong>
                      <small>{member.jobTitle ?? 'Pollux Motors'}</small>
                    </span>
                  </li>
                ))}
              </ul>
              <div className="form-actions">
                <button type="button" className="button button-ghost button-danger-text" onClick={() => setLeaving(true)}>
                  <LogOut size={15} /> Leave group
                </button>
              </div>
            </>
          )}
        </div>
      </Modal>
      <ConfirmDialog
        open={leaving}
        title="Leave this group?"
        message="You stop receiving its messages and lose access to its history. Someone in the group can add you back."
        confirmLabel="Leave group"
        tone="danger"
        onClose={() => setLeaving(false)}
        onConfirm={async () => {
          await leaveGroupChat(conversation.id)
          onToast(`You left ${conversation.title}.`)
          onLeft()
        }}
      />
    </>
  )
}

/** One open conversation: the thread, kept current by polling, and the composer. */
export function ChatThread({ conversationId, onBack, onListChanged, onLeft, onToast }) {
  const info = useResource(() => fetchConversation(conversationId), [conversationId])
  const [messages, setMessages] = useState([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [olderLoading, setOlderLoading] = useState(false)
  const [draft, setDraft] = useState('')
  const [sendError, setSendError] = useState(null)
  const [sending, setSending] = useState(false)
  const [groupOpen, setGroupOpen] = useState(false)
  const [unsending, setUnsending] = useState(null)

  const listRef = useRef(null)
  const composerRef = useRef(null)
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  // Follow new messages only when the reader is already at the bottom.
  const pinned = useRef(true)
  const restoreFrom = useRef(null)

  const markRead = useCallback(async () => {
    try {
      await markConversationRead(conversationId)
      emitChange('chat')
    } catch {
      // A missed read mark only leaves a badge up until the next one.
    }
  }, [conversationId])

  const loadLatest = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const result = await fetchMessages(conversationId)
      setMessages(result.items)
      setHasMore(result.hasMore)
      pinned.current = true
      markRead()
    } catch (caught) {
      setLoadError(caught)
    } finally {
      setLoading(false)
    }
  }, [conversationId, markRead])

  useEffect(() => {
    setMessages([])
    setDraft('')
    loadLatest()
  }, [loadLatest])

  usePolling(
    async () => {
      const since = latestChange(messagesRef.current)
      try {
        const result = await fetchMessages(conversationId, since ? { since } : {})
        const changed = changedMessages(messagesRef.current, result.items)
        if (!changed.length) return
        const known = new Set(messagesRef.current.map((message) => message.id))
        const arrived = changed.filter((message) => !known.has(message.id))
        setMessages((current) => mergeMessages(current, changed))
        // Reading them here also refreshes the list and the badge.
        if (arrived.some((message) => !message.isMine)) markRead()
        if (arrived.some((message) => message.isSystem)) info.reload()
      } catch {
        // The next poll tries again; a dropped poll is not worth an error.
      }
    },
    THREAD_POLL_MS,
    !loading && !loadError,
  )

  // Keep the view where the reader expects it: at the newest message, or - after
  // loading older history - exactly where they were.
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    if (restoreFrom.current !== null) {
      list.scrollTop = list.scrollHeight - restoreFrom.current
      restoreFrom.current = null
    } else if (pinned.current) {
      list.scrollTop = list.scrollHeight
    }
  }, [messages])

  const onScroll = () => {
    const list = listRef.current
    pinned.current = list.scrollHeight - list.scrollTop - list.clientHeight < 80
  }

  const loadOlder = async () => {
    const oldest = messages[0]
    if (!oldest) return
    setOlderLoading(true)
    try {
      const result = await fetchMessages(conversationId, { before: oldest.createdAt })
      restoreFrom.current = listRef.current.scrollHeight - listRef.current.scrollTop
      setMessages((current) => mergeMessages(current, result.items))
      setHasMore(result.hasMore)
    } catch (caught) {
      onToast(caught.message || 'Could not load earlier messages.', 'error')
    } finally {
      setOlderLoading(false)
    }
  }

  const send = async (event) => {
    event?.preventDefault()
    const body = draft.trim()
    if (!body || sending) return
    setSending(true)
    setSendError(null)
    try {
      const message = await sendChatMessage(conversationId, body)
      pinned.current = true
      setMessages((current) => mergeMessages(current, [message]))
      setDraft('')
      onListChanged()
    } catch (caught) {
      setSendError(caught)
    } finally {
      setSending(false)
      composerRef.current?.focus()
    }
  }

  const conversation = info.data
  const isGroup = conversation?.kind === 'GROUP'
  const rows = threadRows(messages)

  return (
    <div className="chat-thread">
      <header className="chat-thread-head">
        <button type="button" className="icon-button chat-back" onClick={onBack} aria-label="Back to conversations">
          <ArrowLeft size={18} />
        </button>
        {conversation ? (
          <>
            <ConversationAvatar conversation={conversation} size="sm" />
            <div className="chat-thread-title">
              <h2>{conversation.title}</h2>
              <small>{conversation.subtitle}</small>
            </div>
            {isGroup && (
              <button type="button" className="button button-secondary button-sm" onClick={() => setGroupOpen(true)}>
                <UsersRound size={15} /> <span className="hide-sm">Members</span>
              </button>
            )}
          </>
        ) : (
          <div className="chat-thread-title">{info.error ? <h2>Conversation</h2> : <Spinner size={16} />}</div>
        )}
      </header>

      <div className="chat-messages" ref={listRef} onScroll={onScroll} aria-live="polite" aria-label="Messages">
        {(loading || info.loading) && <LoadingState label="Loading messages…" />}
        {(loadError || info.error) && <ErrorState error={loadError || info.error} onRetry={loadError ? loadLatest : info.reload} />}
        {!loading && !loadError && !info.error && (
          <>
            {hasMore && (
              <div className="chat-older">
                <button type="button" className="button button-ghost button-sm" onClick={loadOlder} disabled={olderLoading}>
                  {olderLoading && <Spinner size={14} />} Load earlier messages
                </button>
              </div>
            )}
            {!messages.length && (
              <EmptyState icon={MessagesSquare} title="No messages yet" text={conversation ? `Say hello to ${isGroup ? 'the group' : conversation.title.split(' ')[0]}.` : undefined} />
            )}
            <ol className="chat-list-messages">
              {rows.map((row) => {
                if (row.type === 'day') {
                  return (
                    <li key={row.key} className="msg-day">
                      <span>{row.label}</span>
                    </li>
                  )
                }
                const { message, continued } = row
                if (message.isSystem) {
                  return (
                    <li key={row.key} className="msg-system">
                      <span>{message.body}</span>
                    </li>
                  )
                }
                return (
                  <li key={row.key} className={`msg ${message.isMine ? 'msg-mine' : ''} ${continued ? 'msg-continued' : ''}`}>
                    {!message.isMine && (continued ? <span className="msg-avatar-gap" /> : <Avatar employee={chatPerson(message.sender ?? { id: 'gone', fullName: 'Former colleague' })} size="sm" />)}
                    <div className="msg-body">
                      {!message.isMine && !continued && isGroup && <span className="msg-sender">{message.sender?.fullName ?? 'Former colleague'}</span>}
                      <div className={`msg-bubble ${message.isDeleted ? 'msg-deleted' : ''}`}>
                        {message.isDeleted ? 'Message deleted' : message.body}
                        <time dateTime={message.createdAt} title={new Date(message.createdAt).toLocaleString()}>
                          {formatTime(message.createdAt)}
                        </time>
                      </div>
                    </div>
                    {message.isMine && !message.isDeleted && (
                      <button type="button" className="msg-delete" onClick={() => setUnsending(message)} aria-label="Delete message" title="Delete message">
                        <Trash2 size={14} />
                      </button>
                    )}
                  </li>
                )
              })}
            </ol>
          </>
        )}
      </div>

      <form className="chat-composer" onSubmit={send}>
        <label className="sr-only" htmlFor="chat-draft">
          Message
        </label>
        <textarea
          id="chat-draft"
          ref={composerRef}
          rows="1"
          value={draft}
          maxLength={4000}
          placeholder={conversation ? `Message ${isGroup ? conversation.title : conversation.title.split(' ')[0]}` : 'Message'}
          onChange={(event) => {
            setDraft(event.target.value)
            event.target.style.height = 'auto'
            event.target.style.height = `${Math.min(event.target.scrollHeight, 160)}px`
          }}
          onKeyDown={(event) => {
            // Enter sends; Shift+Enter is a new line. Never mid-composition
            // (Arabic and other IMEs use Enter to confirm a word).
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) send(event)
          }}
          disabled={Boolean(loadError || info.error)}
        />
        <button type="submit" className="button button-primary chat-send" disabled={sending || !draft.trim()} aria-label="Send message">
          {sending ? <Spinner size={16} /> : <Send size={16} />}
        </button>
      </form>
      {sendError && (
        <div className="chat-send-error">
          <FormError error={sendError} />
        </div>
      )}

      {conversation && isGroup && (
        <GroupInfoModal
          open={groupOpen}
          conversation={conversation}
          onClose={() => setGroupOpen(false)}
          onChanged={() => {
            info.reload()
            onListChanged()
          }}
          onLeft={() => {
            setGroupOpen(false)
            onLeft()
          }}
          onToast={onToast}
        />
      )}
      <ConfirmDialog
        open={Boolean(unsending)}
        title="Delete this message?"
        message="It is removed for everyone in the conversation. They will see that a message was deleted."
        confirmLabel="Delete"
        tone="danger"
        onClose={() => setUnsending(null)}
        onConfirm={async () => {
          const updated = await deleteChatMessage(conversationId, unsending.id)
          setMessages((current) => mergeMessages(current, [updated]))
          onListChanged()
        }}
      />
    </div>
  )
}
