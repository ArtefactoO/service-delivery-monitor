import React from 'react'
import ReactDOM from 'react-dom/client'
import { UiProvider } from '@project/ui/mui'
import App from './App'
import {FreshnessProvider} from './Freshness'
import './styles.css'
import './compact-service.css'
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><UiProvider storageKey="delivery-monitor-ui"><FreshnessProvider><App /></FreshnessProvider></UiProvider></React.StrictMode>)
