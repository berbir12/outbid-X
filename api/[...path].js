// Vercel serverless entry point. Express keeps the original /api/* request path,
// so the same handlers are used locally and in production.
export { default } from '../server.js';
