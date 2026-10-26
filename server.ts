import express from 'express';
import { createServer as createViteServer } from 'vite';
import { getDb, saveToDisk } from './src/server/db.ts';
import { startOutboxWorker, stopOutboxWorker } from './src/server/outbox.ts';
import { apiRouter, hydrateServerFromFirestore } from './src/server/routes.ts';
import path from 'path';
import fs from 'fs';

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  // Initialize SQL.JS SQLite database with persistent disk storage
  try {
    await getDb();
    console.log('✓ VedirtSetu Database Initialized with persistent schema & seed data');
    await hydrateServerFromFirestore();
    startOutboxWorker();
  } catch (err) {
    console.error('Database initialization error:', err);
  }

  // Graceful shutdown to guarantee database is saved before process termination
  process.on('SIGINT', () => {
    try { stopOutboxWorker(); } catch (e) {}
    try { saveToDisk(); } catch (e) {}
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    try { stopOutboxWorker(); } catch (e) {}
    try { saveToDisk(); } catch (e) {}
    process.exit(0);
  });

  // Allow up to 10MB JSON payloads for base64 QR code images and bulk syncs
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Mount API endpoints
  app.use('/api', apiRouter);

  // Health check endpoint
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // In production serve dist, otherwise mount Vite middlewares
  const isProd = process.env.NODE_ENV === 'production' && fs.existsSync(path.resolve(process.cwd(), 'dist'));
  if (isProd) {
    app.use(express.static(path.resolve(process.cwd(), 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve(process.cwd(), 'dist', 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✓ VedirtSetu B2B Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch(console.error);