import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import { brand } from './config/brand';

// public/index.html titles the page %REACT_APP_APP_NAME%, which CRA fills in
// at build time only when the variable is set. Without it the default name
// still reaches the tab.
document.title = brand.appName;

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
