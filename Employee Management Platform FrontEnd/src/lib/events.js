import { useEffect, useRef } from 'react'

/**
 * Cross-component "this changed" signals. The topbar check-in button and the
 * attendance card on Home are different components showing the same state;
 * after either acts, the other reloads.
 */
const EVENT = 'pollux:changed'

export function emitChange(topic) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: topic }))
}

export function useChangeListener(topic, callback) {
  const ref = useRef(callback)
  ref.current = callback
  useEffect(() => {
    const handler = (event) => {
      if (event.detail === topic) ref.current()
    }
    window.addEventListener(EVENT, handler)
    return () => window.removeEventListener(EVENT, handler)
  }, [topic])
}
