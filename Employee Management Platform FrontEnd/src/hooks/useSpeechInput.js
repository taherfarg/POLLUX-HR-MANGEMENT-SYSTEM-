import { useCallback, useEffect, useRef, useState } from 'react'

const Recognition = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : undefined

/**
 * Dictation through the browser's own speech recognition (Chrome, Edge,
 * Safari). `onText` receives the words heard so far, then the final text.
 * Where the browser has none, `supported` is false and nothing is shown.
 */
export function useSpeechInput({ lang, onText }) {
  const [listening, setListening] = useState(false)
  const [error, setError] = useState(null)
  const recognitionRef = useRef(null)
  const onTextRef = useRef(onText)
  onTextRef.current = onText

  useEffect(() => () => recognitionRef.current?.abort(), [])

  const start = useCallback(() => {
    if (!Recognition) return
    recognitionRef.current?.abort()
    const recognition = new Recognition()
    recognition.lang = lang
    recognition.interimResults = true
    recognition.continuous = false
    recognition.onresult = (event) => {
      const text = Array.from(event.results)
        .map((result) => result[0]?.transcript ?? '')
        .join(' ')
      onTextRef.current(text.trim())
    }
    recognition.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') setError('Allow the microphone for this site to dictate.')
      else if (event.error !== 'aborted' && event.error !== 'no-speech') setError('Could not hear that - try again.')
    }
    recognition.onend = () => setListening(false)
    recognitionRef.current = recognition
    setError(null)
    setListening(true)
    recognition.start()
  }, [lang])

  const stop = useCallback(() => recognitionRef.current?.stop(), [])

  return { supported: Boolean(Recognition), listening, error, start, stop }
}
