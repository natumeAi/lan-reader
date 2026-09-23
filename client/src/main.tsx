import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';
import './styles/base.css';
import './styles/bookshelf.css';
import './styles/folders.css';
import './styles/home.css';
import './styles/pwa.css';

const root = document.getElementById('root');
if (!root) throw new Error('Application root is missing');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
