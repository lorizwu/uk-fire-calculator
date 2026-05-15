import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

const root = document.getElementById('root');
try {
  console.log("Mounting React app...");
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
} catch (e) {
  console.error("Mount error:", e);
  root.innerHTML = `<div style="color:red;padding:20px;">
    <h1>Mount Error</h1>
    <pre>${e.message}\n${e.stack}</pre>
  </div>`;
}
window.addEventListener('error', (event) => {
  console.error("Global error:", event.error);
  if (root && !root.children.length) {
    root.innerHTML = `<div style="color:red;padding:20px;">
      <h1>Runtime Error</h1>
      <pre>${event.error ? event.error.message : 'Unknown error'}\n${event.error ? event.error.stack : ''}</pre>
    </div>`;
  }
});
