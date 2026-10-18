require('dotenv').config();
const app = require('./src/app');
const { expireUnaccepted } = require('./src/controllers/reassignment.controller');
const { generateDueSettlements } = require('./src/services/settlements');
const { processQueue: processWhatsappQueue } = require('./src/services/whatsapp');
const { dispatch: dispatchWhatsappEvents } = require('./src/services/whatsappEvents');
const { sweep: sweepAdCampaigns } = require('./src/services/adCampaigns');
const { attributeOrders: attributeAdOrders } = require('./src/services/adServing');

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

// Re-routes orders a shop hasn't accepted within the admin's window
// (Admin → Vendor Matching). MATCHING_SWEEP_SECONDS=0 turns it off.
const sweepSeconds = Number(process.env.MATCHING_SWEEP_SECONDS ?? 60);
if (sweepSeconds > 0) {
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const moved = await expireUnaccepted();
      if (moved.length) console.log(`[matching] accept window: ${moved.map((m) => `#${m.orderId} ${m.status}`).join(', ')}`);
    } catch (err) {
      console.error(`[matching] accept-window sweep failed: ${err.message}`);
    } finally {
      running = false;
    }
  }, sweepSeconds * 1000).unref();
}

// Closes finished weekly settlement cycles (Admin → Settlements). Hourly; it
// also runs whenever the Settlements page loads. SETTLEMENT_SWEEP_MINUTES=0 turns it off.
const settlementMinutes = Number(process.env.SETTLEMENT_SWEEP_MINUTES ?? 60);
if (settlementMinutes > 0) {
  setInterval(() => {
    generateDueSettlements()
      .then((made) => made.length && console.log(`[settlements] generated ${made.length}`))
      .catch((err) => console.error(`[settlements] generation failed: ${err.message}`));
  }, settlementMinutes * 60000).unref();
}

// Ad campaigns go live and finish on their dates (Admin → Ad Promotions).
// AD_SWEEP_SECONDS=0 turns it off.
const adSeconds = Number(process.env.AD_SWEEP_SECONDS ?? 60);
if (adSeconds > 0) {
  let sweeping = false;
  setInterval(async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      const moved = await sweepAdCampaigns();
      if (moved.length) console.log(`[ads] ${moved.map((m) => `#${m.id} ${m.from}→${m.to}`).join(', ')}`);
      // Delivered orders that came from an ad tap are credited to it.
      const credited = await attributeAdOrders();
      if (credited) console.log(`[ads] ${credited} order(s) credited to ads`);
    } catch (err) {
      console.error(`[ads] schedule sweep failed: ${err.message}`);
    } finally {
      sweeping = false;
    }
  }, adSeconds * 1000).unref();
}

// Sends queued WhatsApp messages and retries ones that failed for a reason
// that may pass (Admin → Channels → WhatsApp). WHATSAPP_SWEEP_SECONDS=0 turns it off.
const whatsappSeconds = Number(process.env.WHATSAPP_SWEEP_SECONDS ?? 15);
if (whatsappSeconds > 0) {
  let sending = false;
  setInterval(async () => {
    if (sending) return;
    sending = true;
    try {
      // Order events become queued messages first, then the queue is sent.
      const d = await dispatchWhatsappEvents();
      if (d.queued || d.skipped) console.log(`[whatsapp] order updates: ${d.queued} queued, ${d.skipped} skipped`);
      const r = await processWhatsappQueue();
      if (r.sent || r.failed) console.log(`[whatsapp] sent ${r.sent}, failed ${r.failed}, retrying ${r.retrying}`);
    } catch (err) {
      console.error(`[whatsapp] queue failed: ${err.message}`);
    } finally {
      sending = false;
    }
  }, whatsappSeconds * 1000).unref();
}
