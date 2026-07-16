import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { LocaleProvider } from './locales';
import './index.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('ルート要素 #root が見つかりません。');
}

createRoot(rootElement).render(
  <LocaleProvider>
    {/* アプリ全体を Error Boundary で包み、描画中の想定外例外による白画面を防ぐ。 */}
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </LocaleProvider>,
);
