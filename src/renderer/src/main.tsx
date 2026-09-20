import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/theme.css'
import { I18nProvider } from './i18n'
import { MigrationGateHost } from './views/MigrationGate'

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')

createRoot(container).render(
  <StrictMode>
    <I18nProvider>
      {/*
        ★ 闸门在 App **外面**,不是叠在它上面。迁移期间数据库还没打开,App 的
        握手 effect 一跑就会 invoke `app:getBootstrap` 并失败,把首屏置成
        「握手失败」—— 而闸门一放行,用户看到的就是那一屏错误。
        包在外面,App 的 effect 在闸门结束之前一次都不会跑(见 MigrationGate 文件头)。
      */}
      <MigrationGateHost>
        <App />
      </MigrationGateHost>
    </I18nProvider>
  </StrictMode>
)
