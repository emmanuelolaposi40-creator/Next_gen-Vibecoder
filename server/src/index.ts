import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 3001);
const dbPath = process.env.DATABASE_URL ?? path.resolve(__dirname, '../../data/patrol.db');
const staticDir = path.resolve(__dirname, '../../client/dist');

const app = buildApp({ dbPath, staticDir });

app
  .listen({ port, host: '0.0.0.0' })
  .then(() => {
    console.log(`Patrol server listening on http://0.0.0.0:${port}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
