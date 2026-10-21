/**
 * Text messages (login OTPs).
 *
 * Provider: MSG91 (user's choice, 2026-10-21). Indian DLT rules mean an OTP
 * can only go out through a registered template, so MSG91 is driven with
 * its Send OTP API: we pass our own 6-digit code and the template's id, and
 * MSG91 fills the template's ##OTP## variable with it. Nothing free-form is
 * sent.
 *
 *   SMS_PROVIDER=msg91
 *   MSG91_AUTH_KEY=...            (MSG91 dashboard -> Authkey)
 *   MSG91_OTP_TEMPLATE_ID=...     (an approved OTP template with ##OTP##)
 *
 * Without a provider, development builds print the message to the server
 * console the way the mailer mock does, and production refuses: an OTP
 * that never arrives is worse than a clear "not available yet".
 */
const MSG91_OTP_URL = 'https://control.msg91.com/api/v5/otp';

/**
 * MSG91 OTP Widget (used before DLT approval): MSG91 generates the code,
 * sends it with its own default template, and checks it. Endpoints and
 * body keys are the ones MSG91's official sendOTP SDKs call.
 *
 *   MSG91_WIDGET_ID=...     (OTP -> Widgets -> the widget's id)
 *   MSG91_WIDGET_TOKEN=...  (OTP -> Tokens -> a token for that widget)
 */
const MSG91_WIDGET_URL = 'https://control.msg91.com/api/v5/widget';

function provider() {
  return (process.env.SMS_PROVIDER || '').trim().toLowerCase();
}

/**
 * Digits in a phone-login code, so the app can size its field: MSG91's
 * widget makes its own codes (length set on the widget, 4 by default;
 * override with MSG91_OTP_LENGTH), otherwise we make 6-digit ones.
 */
function otpLength() {
  if (!usesWidget()) return 6;
  const n = Number(process.env.MSG91_OTP_LENGTH || 4);
  return Number.isInteger(n) && n >= 4 && n <= 8 ? n : 4;
}

/** True when MSG91's OTP Widget sends and checks the codes itself. */
function usesWidget() {
  return provider() === 'msg91' && Boolean(process.env.MSG91_WIDGET_ID && process.env.MSG91_WIDGET_TOKEN);
}

/** Why the configured provider can't send, or null when it can. */
function configError() {
  switch (provider()) {
    case '':
      return process.env.NODE_ENV === 'production' ? 'No SMS provider is configured' : null;
    case 'msg91':
      if (usesWidget()) return null;
      // The template id is optional on purpose: a missing id is left out of
      // the request and MSG91 decides.
      if (!process.env.MSG91_AUTH_KEY) return 'MSG91_AUTH_KEY (or MSG91_WIDGET_ID + MSG91_WIDGET_TOKEN) is not set';
      return null;
    default:
      return `SMS provider "${process.env.SMS_PROVIDER}" is not supported`;
  }
}

/** POSTs to a widget endpoint; returns MSG91's JSON body (throws on transport/HTTP failure). */
async function widgetPost(path, body) {
  const res = await fetch(`${MSG91_WIDGET_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ widgetId: process.env.MSG91_WIDGET_ID, tokenAuth: process.env.MSG91_WIDGET_TOKEN, ...body }),
  });
  const json = await res.json().catch(() => null);
  console.log(`[sms:msg91-widget] ${path} -> HTTP ${res.status} ${JSON.stringify(json)}`);
  if (!res.ok || !json) throw new Error(json?.message || `MSG91 widget returned ${res.status}`);
  return json;
}

/** Asks MSG91 to text a code to [to]; returns MSG91's request id for [verifyWidgetOtp]. */
async function sendWidgetOtp(to) {
  const body = await widgetPost('/sendOtpMobile', { identifier: msg91Mobile(to) });
  const reqId = body.reqId || body.request_id || body.message;
  if (body.type !== 'success' || !reqId) throw new Error(body.message || 'MSG91 widget did not accept the request');
  return String(reqId);
}

/** True when [otp] is the code MSG91 sent for [reqId]; false when it is wrong or expired. */
async function verifyWidgetOtp(reqId, otp) {
  const body = await widgetPost('/verifyOtp', { reqId, otp: String(otp) });
  return body.type === 'success';
}

function isAvailable() {
  return configError() === null;
}

/** "+91 98765 43210" / "9876543210" -> "919876543210" (MSG91 wants country code, no plus). */
function msg91Mobile(to) {
  const digits = String(to).replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  throw new Error(`Not an Indian mobile number: ${to}`);
}

/**
 * Sends [otp] to [to] through MSG91's Send OTP API. [expiryMinutes] is the
 * validity MSG91 is told about (ours is enforced separately in the DB).
 */
async function sendMsg91Otp({ to, otp, expiryMinutes }) {
  if (!otp) throw new Error('MSG91 only sends templated OTPs: an otp value is required');
  const url = new URL(MSG91_OTP_URL);
  if (process.env.MSG91_OTP_TEMPLATE_ID) url.searchParams.set('template_id', process.env.MSG91_OTP_TEMPLATE_ID);
  url.searchParams.set('mobile', msg91Mobile(to));
  url.searchParams.set('otp', String(otp));
  if (expiryMinutes) url.searchParams.set('otp_expiry', String(expiryMinutes));
  if (process.env.MSG91_SENDER_ID) url.searchParams.set('sender', process.env.MSG91_SENDER_ID);

  const res = await fetch(url, {
    method: 'POST',
    headers: { authkey: process.env.MSG91_AUTH_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: '{}',
  });
  const body = await res.json().catch(() => null);
  // MSG91 answers {type:'success'|'error', message:'<request id or reason>'}.
  if (!res.ok || !body || body.type !== 'success') {
    throw new Error(body?.message || `MSG91 returned ${res.status}`);
  }
  console.log(`[sms:msg91] OTP -> ${to} response=${JSON.stringify(body)}`);
}

/**
 * Sends one text. [text] is the full message for the mock/console; [otp]
 * (and optional [expiryMinutes]) is what a templated provider needs.
 */
async function sendSms({ to, text, otp, expiryMinutes }) {
  const problem = configError();
  if (problem) throw new Error(problem);

  switch (provider()) {
    case 'msg91':
      return sendMsg91Otp({ to, otp, expiryMinutes });
    default:
      console.log(`[sms:mock] Would have sent SMS to ${to}`);
      console.log(`[sms:mock] Text: ${text}`);
  }
}

module.exports = {
  sendSms, isAvailable, configError, msg91Mobile, MSG91_OTP_URL,
  usesWidget, sendWidgetOtp, verifyWidgetOtp, otpLength, MSG91_WIDGET_URL,
};
