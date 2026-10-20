import { useEffect, useRef } from 'react'

/**
 * Calls `callback` every `interval` ms while the page is in front of the
 * user, and once straight away when they come back to it. A hidden tab makes
 * no calls at all, which is most of the day for a tab left open.
 */
export function usePolling(callback, interval, enabled = true) {
  const ref = useRef(callback)
  ref.current = callback

  useEffect(() => {
    if (!enabled) return undefined
    let timer = null
    const visible = () => document.visibilityState !== 'hidden'
    const start = () => {
      if (timer === null) timer = window.setInterval(() => ref.current(), interval)
    }
    const stop = () => {
      if (timer !== null) window.clearInterval(timer)
      timer = null
    }
    const onVisibility = () => {
      if (visible()) {
        ref.current()
        start()
      } else {
        stop()
      }
    }
    if (visible()) start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [interval, enabled])
}
