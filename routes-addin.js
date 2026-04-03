// ClearSignals AI — Outlook Add-in Routes
// Serves the add-in taskpane + icons and adds CORS for Office.js

const path = require('path');
const express = require('express');

module.exports = function(app) {
  // CORS for add-in requests to /api/analyze
  app.use('/api/analyze', function(req, res, next) {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });

  // Serve add-in static files
  app.use('/addin', express.static(path.join(__dirname, 'public', 'addin')));

  console.log('[Add-in] Outlook add-in routes mounted at /addin');
};
