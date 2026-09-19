const nodemailer = require("nodemailer");

/**
 * Gmail SMTP via an app password (GMAIL_USER / GMAIL_APP_PASSWORD in env).
 * Built lazily so a backend missing mail config can still boot — the OTP
 * routes fail loudly with a clear message instead of the whole server
 * crashing at require time.
 */
let transporter;
function getTransporter() {
  if (!transporter) {
    const user = process.env.GMAIL_USER;
    const pass = process.env.GMAIL_APP_PASSWORD;
    if (!user || !pass) {
      throw new Error("GMAIL_USER and GMAIL_APP_PASSWORD must be set to send mail.");
    }
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user, pass },
    });
  }
  return transporter;
}

async function sendMail({ to, subject, text, html }) {
  const from = process.env.GMAIL_USER;
  const info = await getTransporter().sendMail({ from, to, subject, text, html });
  console.log(`[mail] "${subject}" -> accepted=${info.accepted} rejected=${info.rejected} id=${info.messageId}`);
}

module.exports = { sendMail };
