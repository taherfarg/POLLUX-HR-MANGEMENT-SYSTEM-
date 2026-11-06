import React from 'react'
import ReactDOM from 'react-dom/client'
import { IconContext } from '@phosphor-icons/react'
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import App from './App.jsx'
import { AuthProvider } from './hooks/useAuth.jsx'
import { ThemeProvider } from './hooks/useTheme.jsx'
import './styles.css'

// Every icon is decorative (buttons carry their own labels) and outlined by
// default; a selected state asks for weight="fill" where it is drawn.
const ICONS = { color: 'currentColor', size: '1em', weight: 'regular', mirrored: false, 'aria-hidden': true }

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <IconContext.Provider value={ICONS}>
      <ThemeProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ThemeProvider>
    </IconContext.Provider>
  </React.StrictMode>,
)
