import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './fonts.css';
import './styles.css';
import './navigation.css';
import './refinements.css';
import './pointer-feedback.css';
import './learning-integration.css';
import './minimal-controls.css';
import './typography.css';
import './formal-workspace.css';
import './server-connection.css';

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
