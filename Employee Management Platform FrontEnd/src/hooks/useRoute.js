import { useCallback, useEffect, useState } from 'react'

/**
 * A tiny hash router: `#/employees/abc123` -> { page: 'employees', param: 'abc123' }.
 * Hash routing needs no server configuration, survives a refresh, and gives
 * the back button something to do - without adding a router dependency.
 */
function parse(hash) {
  const [page = '', param = null] = hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent)
  return { page, param }
}

export function useRoute() {
  const [route, setRoute] = useState(() => parse(window.location.hash))

  useEffect(() => {
    const onChange = () => setRoute(parse(window.location.hash))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  const navigate = useCallback((page, param) => {
    const next = `#/${page}${param ? `/${encodeURIComponent(param)}` : ''}`
    if (window.location.hash === next) {
      setRoute(parse(next))
    } else {
      window.location.hash = next
    }
  }, [])

  return { ...route, navigate }
}
