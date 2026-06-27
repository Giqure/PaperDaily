import process from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Load server/.env into process.env using Node's built-in loader (v20.6+),
// so there's no dependency. Resolved relative to the server root rather than
// cwd, so it works no matter where the process is launched from. A missing
// file is fine — we just fall back to the ambient environment. Real env vars
// already set take precedence (loadEnvFile won't clobber them at the OS level,
// but values here only fill in what's unset).
const envPath = path.join(fileURLToPath(import.meta.url), '..', '..', '.env');

try {
  process.loadEnvFile(envPath);
} catch {
  // No .env present (or unreadable) — rely on the ambient environment.
}
