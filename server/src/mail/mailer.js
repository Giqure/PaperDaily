// Shared SMTP mailer for transactional mail (e.g. the email-push confirmation
// link). Reuses the operator-level SMTP transport from reporterConfig().push
// .email — the same credentials the reporter uses to send digests — so there's
// one place to configure outgoing mail.

import { reporterConfig } from '../reporter/config.js';

const log = (...parts) => console.log('[mail]', ...parts);

// True when the operator has fully configured the SMTP transport.
export function emailConfigured(cfg = reporterConfig()) {
  const e = cfg.push.email;
  const user = e.smtpUser || e.from;
  return !!(e.from && e.smtpHost && user && e.smtpPassword);
}

// Build an SMTP transport (lazy nodemailer import). Returns null if nodemailer
// isn't installed or SMTP isn't configured.
async function makeTransporter(cfg) {
  if (!emailConfigured(cfg)) return null;
  let nodemailer;
  try {
    ({ default: nodemailer } = await import('nodemailer'));
  } catch {
    log('nodemailer 未安装, 无法发送邮件');
    return null;
  }
  const e = cfg.push.email;
  return nodemailer.createTransport({
    host: e.smtpHost,
    port: e.smtpPort,
    secure: e.smtpUseSsl, // true for 465, false for STARTTLS on 587
    auth: { user: e.smtpUser || e.from, pass: e.smtpPassword },
  });
}

/**
 * Send a single transactional email. Resolves true on success, false if mail
 * isn't configured or sending failed. Never throws — callers decide how to
 * surface a failure to the user.
 */
export async function sendMail({ to, subject, text, html }) {
  const cfg = reporterConfig();
  const transporter = await makeTransporter(cfg);
  if (!transporter) return false;
  try {
    await transporter.sendMail({ from: cfg.push.email.from, to, subject, text, html });
    log('已发送 ->', to);
    return true;
  } catch (err) {
    log(`发送失败 (${to}):`, err.message);
    return false;
  }
}
