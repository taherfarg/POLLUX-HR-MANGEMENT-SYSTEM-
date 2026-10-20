import { useState } from 'react'
import { MessageSquarePlus, MessagesSquare } from 'lucide-react'
import { EmptyState, ErrorState, LoadingState, SearchInput } from '../components/ui.jsx'
import { ChatThread, ConversationAvatar, NewChatModal } from '../components/chat.jsx'
import { useResource } from '../hooks/useResource.js'
import { usePolling } from '../hooks/usePolling.js'
import { listTime, previewLine } from '../lib/chat.js'
import { emitChange, useChangeListener } from '../lib/events.js'
import { fetchConversations } from '../api/endpoints.js'

/** How often the conversation list refreshes while the page is open. */
const LIST_POLL_MS = 10_000

/**
 * Chat: the conversation list beside the open conversation. On a phone the two
 * take turns - the list, then the conversation with a way back.
 */
export default function ChatPage({ param, navigate, onToast }) {
  const conversations = useResource(fetchConversations, [])
  const [filter, setFilter] = useState('')
  const [starting, setStarting] = useState(false)
  usePolling(conversations.reload, LIST_POLL_MS)
  // Anything that changes unread counts - reading, sending, leaving - is
  // announced once; the list here and the badge in the navigation both follow.
  useChangeListener('chat', conversations.reload)
  const refreshList = () => emitChange('chat')

  const items = conversations.data?.items ?? []
  const needle = filter.trim().toLowerCase()
  const shown = needle ? items.filter((item) => item.title.toLowerCase().includes(needle)) : items

  return (
    <div className={`chat-layout ${param ? 'chat-open' : ''}`}>
      <aside className="chat-sidebar" aria-label="Conversations">
        <header className="chat-sidebar-head">
          <div>
            <h2>Chat</h2>
            <small>{conversations.data?.totalUnread ? `${conversations.data.totalUnread} unread` : 'Messages with colleagues'}</small>
          </div>
          <button type="button" className="button button-primary button-sm" onClick={() => setStarting(true)}>
            <MessageSquarePlus size={16} /> New
          </button>
        </header>
        <div className="chat-filter">
          <SearchInput value={filter} onChange={setFilter} placeholder="Find a conversation" label="Find a conversation" />
        </div>
        <div className="chat-conversations">
          {conversations.loading && <LoadingState rows={5} />}
          {conversations.error && <ErrorState error={conversations.error} onRetry={conversations.reload} compact />}
          {!conversations.loading && !conversations.error && !items.length && (
            <EmptyState
              icon={MessagesSquare}
              title="No conversations yet"
              text="Message a colleague directly, or start a group for your team."
              action={
                <button className="button button-secondary" onClick={() => setStarting(true)}>
                  <MessageSquarePlus size={16} /> Start a conversation
                </button>
              }
            />
          )}
          <ul>
            {shown.map((conversation) => (
              <li key={conversation.id}>
                <button
                  type="button"
                  className={`conversation-item ${conversation.id === param ? 'active' : ''} ${conversation.unreadCount ? 'unread' : ''}`}
                  aria-current={conversation.id === param ? 'true' : undefined}
                  onClick={() => navigate('chat', conversation.id)}
                >
                  <ConversationAvatar conversation={conversation} />
                  <span className="conversation-text">
                    <span className="conversation-line">
                      <strong>{conversation.title}</strong>
                      <time dateTime={conversation.lastMessageAt}>{listTime(conversation.lastMessageAt)}</time>
                    </span>
                    <span className="conversation-line">
                      <small>{previewLine(conversation)}</small>
                      {conversation.unreadCount > 0 && (
                        <b aria-label={`${conversation.unreadCount} unread`}>{conversation.unreadCount > 99 ? '99+' : conversation.unreadCount}</b>
                      )}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      <section className="chat-main">
        {param ? (
          <ChatThread
            key={param}
            conversationId={param}
            onBack={() => navigate('chat')}
            onListChanged={refreshList}
            onLeft={() => {
              refreshList()
              navigate('chat')
            }}
            onToast={onToast}
          />
        ) : (
          <div className="chat-placeholder">
            <EmptyState icon={MessagesSquare} title="Pick a conversation" text="Choose one on the left, or start a new one." />
          </div>
        )}
      </section>

      <NewChatModal
        open={starting}
        onClose={() => setStarting(false)}
        onOpened={(conversation) => {
          setStarting(false)
          conversations.reload()
          navigate('chat', conversation.id)
        }}
      />
    </div>
  )
}
