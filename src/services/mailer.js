/**
 * Mail over Resend's HTTPS API rather than SMTP.
 *
 * Render blocks outbound SMTP ports on its lower tiers, so a Gmail
 * transport hangs for two minutes and then fails — the credentials are
 * never the problem, the port is simply unreachable. HTTPS is not
 * blocked, so the same mail goes out over the API instead.
 *
 * MAIL_FROM must be an address Resend will send as: their shared
 * onboarding@resend.dev works without any DNS setup but only delivers to
 * the account's own address, which is enough for an OTP going to one
 * inbox. Sending anywhere else needs a verified domain.
 */
const MAIL_FROM = process.env.MAIL_FROM || 'onboarding@resend.dev';

async function sendMail({ to, subject, text, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY must be set to send mail.');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, text, html }),
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.message || `Resend returned ${res.status}`);
  }
  console.log(`[mail] "${subject}" -> ${to} id=${body?.id}`);
}

module.exports = { sendMail };
