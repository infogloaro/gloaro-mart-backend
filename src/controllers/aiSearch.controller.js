const { queryProducts, attachTiers } = require('./product.controller');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-haiku-4-5';

const FILTER_TOOL = {
  name: 'extract_search_filters',
  description: 'Extract structured product-search filters from a natural-language shopping query.',
  input_schema: {
    type: 'object',
    properties: {
      keywords: {
        type: 'string',
        description: 'Core product keywords to match against product names, e.g. "waterproof shoes". Empty string if none.',
      },
      category: {
        type: 'string',
        description: 'A likely product category guess (e.g. "Footwear", "Electronics"), or empty string if unclear.',
      },
      minPriceRupees: {
        type: 'number',
        description: 'Minimum price in INR rupees implied by the query, or null if none.',
      },
      maxPriceRupees: {
        type: 'number',
        description:
          'Maximum price in INR rupees implied by the query (e.g. "under 500" -> 500, "cheap" -> a reasonable low ceiling like 1000), or null if none.',
      },
    },
    required: ['keywords'],
  },
};

// Never throws: returns null on missing key / API error / timeout so the
// caller always falls back to plain keyword search instead of failing.
async function parseQueryWithClaude(query) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 300,
        tools: [FILTER_TOOL],
        tool_choice: { type: 'tool', name: 'extract_search_filters' },
        messages: [{ role: 'user', content: query }],
      }),
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const toolUse = (data.content || []).find((b) => b.type === 'tool_use');
    return toolUse ? toolUse.input : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function aiSearch(req, res) {
  const { query } = req.body || {};
  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ message: 'query is required' });
  }

  const filters = await parseQueryWithClaude(query.trim());

  let products;
  let aiApplied = false;
  if (filters) {
    aiApplied = true;
    products = await queryProducts({
      q: filters.keywords || query.trim(),
      category: filters.category || undefined,
      minPriceCents: filters.minPriceRupees != null ? Math.round(filters.minPriceRupees * 100) : undefined,
      maxPriceCents: filters.maxPriceRupees != null ? Math.round(filters.maxPriceRupees * 100) : undefined,
    });
  } else {
    products = await queryProducts({ q: query.trim() });
  }

  const includeTiers = req.query.includeTiers === 'true';
  const withTiers = includeTiers ? await attachTiers(products) : products;

  res.json({ results: withTiers, aiApplied });
}

module.exports = { aiSearch };
