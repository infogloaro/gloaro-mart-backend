const AnthropicModule = require('@anthropic-ai/sdk');
const pool = require('../config/db');
const { queryCatalogue, toListingJson } = require('./search.controller');
const { deriveGroupStatus } = require('./order.controller');

const Anthropic = AnthropicModule.default || AnthropicModule;
const MODEL = 'claude-opus-5-5';
const MAX_TOOL_ROUNDS = 5;
const MAX_TURNS = 12;
const MAX_TEXT = 1000;

const LANGUAGES = {
  en: 'English',
  ta: 'Tamil (தமிழ், in Tamil script)',
  hi: 'Hindi (हिन्दी, in Devanagari script)',
};

// Screens the app can open from a reply (the bot's "Open …" buttons).
const SCREENS = ['orders', 'offers', 'wallet', 'rewards', 'support', 'cart', 'near_me'];

const SYSTEM = `You are Gloaro Assistant, the shopping helper inside the Gloaro Mart app — a hyperlocal marketplace in India where nearby shops sell groceries, everyday goods and services, delivered or picked up.

How you work:
- Check before you answer. Prices, stock, shops, products and order status come only from your tools, never from memory or guesses. Call search_products for anything about what is sold or what it costs, and my_orders for anything about the shopper's own orders.
- If a tool returns nothing, say plainly that you found nothing, and suggest a different search. Never invent a product, price, discount, delivery time, fee, return rule or policy. When you don't know a policy, say so and offer the Help & Support screen via open_screen.
- When a screen in the app does what the shopper wants (track orders, see offers, wallet balance, rewards points, raise a support ticket, the cart, Near Me shops and services), call open_screen so the app shows a button for it.
- Prices are in Indian rupees; write them like ₹499.
- Keep replies short and friendly: 1–4 sentences, or a short list. Products you found are shown to the shopper as cards under your reply, so name at most the top few instead of listing everything.
- Payments, card numbers, passwords and OTPs: never ask for them. Refer the shopper to the app's checkout or Support.`;

const TOOLS = [
  {
    name: 'search_products',
    description:
      "Search the live Gloaro Mart catalogue (approved shops only). Returns up to 6 products with price in rupees, MRP, discount, shop, city and whether it's in stock. Use short keywords in English, e.g. \"rice\", \"basmati rice\", \"shampoo\".",
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        keywords: { type: 'string', description: 'Product keywords. Empty string to browse a category.' },
        category: { type: ['string', 'null'], description: 'Exact category name if the shopper named one, else null.' },
        min_price_rupees: { type: ['number', 'null'] },
        max_price_rupees: { type: ['number', 'null'], description: '"under 500" → 500.' },
        sort: {
          type: 'string',
          enum: ['relevance', 'price_asc', 'price_desc', 'discount', 'rating', 'popular', 'newest'],
        },
      },
      required: ['keywords', 'category', 'min_price_rupees', 'max_price_rupees', 'sort'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_categories',
    description: 'The category names the catalogue uses, for picking an exact category.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'my_orders',
    description:
      "The signed-in shopper's 5 most recent purchases: reference, status, total, date and shops. Returns signed_in=false when the shopper isn't signed in.",
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'open_screen',
    description: 'Show the shopper a button that opens a screen of the app.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { screen: { type: 'string', enum: SCREENS } },
      required: ['screen'],
      additionalProperties: false,
    },
  },
];

const rupees = (cents) => (cents == null ? null : Math.round(Number(cents)) / 100);

/** Runs one tool; returns the JSON the model reads and collects what the app shows. */
async function runTool(name, input, ctx) {
  switch (name) {
    case 'search_products': {
      const query = { inStock: 'true' };
      if (input.keywords) query.q = String(input.keywords).slice(0, 80);
      if (input.category) query.category = String(input.category);
      if (input.min_price_rupees != null) query.minPriceCents = String(Math.round(input.min_price_rupees * 100));
      if (input.max_price_rupees != null) query.maxPriceCents = String(Math.round(input.max_price_rupees * 100));
      if (input.sort && input.sort !== 'relevance') query.sort = input.sort;
      const { rows } = await queryCatalogue(query, { limit: 6 });
      const listing = rows.map(toListingJson);
      for (const p of listing) if (!ctx.products.some((q) => q.id === p.id)) ctx.products.push(p);
      return {
        count: listing.length,
        products: listing.map((p) => ({
          id: p.id,
          name: p.name,
          price_rupees: rupees(p.price_cents),
          mrp_rupees: rupees(p.mrp_cents),
          discount_percent: p.discount_percent,
          category: p.category,
          shop: p.vendor_name,
          city: p.vendor_city,
          in_stock: p.in_stock,
        })),
      };
    }
    case 'list_categories': {
      const { rows } = await pool.query('SELECT name FROM categories WHERE is_active = true ORDER BY sort_order, name');
      return { categories: rows.map((r) => r.name) };
    }
    case 'my_orders': {
      if (!ctx.userId) return { signed_in: false };
      const { rows } = await pool.query(
        `SELECT cg.reference, cg.total_cents, cg.created_at, cg.payment_status,
                ARRAY_AGG(vp.business_name ORDER BY o.id) AS shops,
                ARRAY_AGG(o.status ORDER BY o.id) AS statuses
         FROM checkout_groups cg
         JOIN orders o ON o.checkout_group_id = cg.id
         JOIN vendor_profiles vp ON vp.id = o.vendor_id
         WHERE cg.user_id = $1
         GROUP BY cg.id ORDER BY cg.created_at DESC LIMIT 5`,
        [ctx.userId]
      );
      return {
        signed_in: true,
        orders: rows.map((r) => ({
          reference: r.reference,
          status: deriveGroupStatus(r.statuses),
          total_rupees: rupees(r.total_cents),
          payment_status: r.payment_status,
          placed_on: new Date(r.created_at).toISOString().slice(0, 10),
          shops: r.shops,
        })),
      };
    }
    case 'open_screen': {
      if (SCREENS.includes(input.screen) && !ctx.actions.includes(input.screen)) ctx.actions.push(input.screen);
      return { shown: true };
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

// A public endpoint that spends API credit: a simple per-address limit.
const WINDOW_MS = 10 * 60 * 1000;
const WINDOW_LIMIT = 30;
const hits = new Map();
function overLimit(key) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > WINDOW_LIMIT;
}

/** The shopper's chat as Messages API turns: plain text, alternating, ending with the shopper. */
function toMessages(raw) {
  const turns = [];
  for (const m of (Array.isArray(raw) ? raw : []).slice(-MAX_TURNS)) {
    const role = m && m.role === 'assistant' ? 'assistant' : 'user';
    const text = typeof m?.text === 'string' ? m.text.trim().slice(0, MAX_TEXT) : '';
    if (!text) continue;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content += `\n\n${text}`;
    else turns.push({ role, content: text });
  }
  while (turns.length && turns[0].role !== 'user') turns.shift();
  return turns.length && turns[turns.length - 1].role === 'user' ? turns : null;
}

let client;

/**
 * POST /api/assistant/chat { messages: [{ role, text }], language }
 *   → { reply, products, actions, aiApplied: true }
 *
 * 503 { aiOff: true } when ANTHROPIC_API_KEY isn't set; the app then answers
 * from its own built-in help and a plain product search.
 */
async function chat(req, res) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ message: 'The assistant is not switched on yet.', aiOff: true });
  }
  const messages = toMessages(req.body?.messages);
  if (!messages) return res.status(400).json({ message: 'messages must end with the shopper’s question' });
  if (overLimit(req.user?.id ? `u${req.user.id}` : req.ip)) {
    return res.status(429).json({ message: 'Too many questions at once. Please wait a few minutes.' });
  }

  const language = LANGUAGES[req.body?.language] || LANGUAGES.en;
  const ctx = { userId: req.user?.id ?? null, products: [], actions: [] };
  client ??= new Anthropic({ timeout: 40_000, maxRetries: 1 });

  try {
    let reply = '';
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 4000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low' },
        system: `${SYSTEM}\n\nAlways reply in ${language}, whatever language the shopper writes in. Keep product names as the shop wrote them.`,
        tools: TOOLS,
        messages,
      });

      if (response.stop_reason === 'refusal') {
        reply = '';
        break;
      }
      // The whole content (thinking and tool calls included) goes back on the next round.
      messages.push({ role: 'assistant', content: response.content });
      reply = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();

      const calls = response.content.filter((b) => b.type === 'tool_use');
      if (response.stop_reason !== 'tool_use' || calls.length === 0) break;

      const results = await Promise.all(
        calls.map(async (call) => {
          try {
            return { type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(await runTool(call.name, call.input || {}, ctx)) };
          } catch (err) {
            console.error('assistant tool', call.name, err.message);
            return { type: 'tool_result', tool_use_id: call.id, content: 'This lookup failed.', is_error: true };
          }
        })
      );
      messages.push({ role: 'user', content: results });
    }

    if (!reply) return res.status(502).json({ message: 'The assistant could not answer that. Please try asking another way.' });
    res.json({ reply, products: ctx.products.slice(0, 6), actions: ctx.actions, aiApplied: true });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ message: 'The assistant is busy. Please try again in a minute.' });
    }
    if (err instanceof Anthropic.APIError || err instanceof Anthropic.APIConnectionError) {
      console.error('assistant api', err.status, err.message);
      return res.status(502).json({ message: 'The assistant is unavailable right now.' });
    }
    throw err;
  }
}

module.exports = { chat, toMessages };
