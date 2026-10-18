/**
 * Starting values for Ad Promotions pricing (schema PHASE 52). They are the
 * brief's SAMPLE numbers — the super admin replaces them in Admin → Ad
 * Promotions → Pricing setup. Inserted only where nothing exists yet, so a
 * re-run never overwrites what the admin has changed.
 */

const LEVELS = [
  ['local', 'Local area', 'Shoppers within a radius of a locality.', 1, 10],
  ['city', 'City', 'Everyone in the chosen cities.', 1, 20],
  ['district', 'District', 'Every place in the chosen districts.', 6, 30],
  ['state', 'State', 'Across the chosen states.', 24, 40],
  ['country', 'Country', 'Across India.', 24, 50],
  ['international', 'International', 'Chosen countries outside India.', 168, 60],
];

// The brief's sample city rates; other levels scale from them.
const CITY_PACKS = [[1, 10000], [6, 40000], [12, 70000], [24, 100000], [168, 500000], [720, 1500000]];
const LEVEL_FACTOR = { local: 0.5, city: 1, district: 1.5, state: 4, country: 15, international: 30 };

const PLACEMENTS = [
  ['home_banner', 'Home page banner', 'The banner carousel at the top of the home screen.', ['1200x400'], null, 5, 50],
  ['city_banner', 'City banner', 'Banner shown to shoppers in the targeted city.', ['1200x400'], ['local', 'city', 'district'], 5, 20],
  ['category_banner', 'Category page banner', 'Banner at the top of a category page.', ['1200x300'], null, 3, 10],
  ['shop_card', 'Shop listing card', 'A promoted card among shop listings.', ['600x600'], null, 10, 0],
  ['product_card', 'Product promotion', 'A promoted product among product lists.', ['600x600'], null, 10, 0],
  ['near_me', 'Near Me promotion', 'Top of the Near Me screen.', ['1200x400'], ['local', 'city'], 5, 10],
  ['festival', 'Festival section', 'The seasonal / festival offers section.', ['1200x400'], null, 8, 30],
  ['sponsored_shop', 'Sponsored shop', 'A shop pinned above organic shop results, marked Sponsored.', ['600x600'], null, 3, 15],
  ['sponsored_search', 'Sponsored search result', 'Up to two results above search results, marked Sponsored.', ['600x600'], null, 2, 25],
];

const ALL_LEVELS = LEVELS.map((l) => l[0]);

async function seedAdPricing(db) {
  await db.query('INSERT INTO ad_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
  for (const [key, label, description, minHours, sort] of LEVELS) {
    await db.query(
      'INSERT INTO ad_levels (key, label, description, min_hours, sort_order) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (key) DO NOTHING',
      [key, label, description, minHours, sort]
    );
  }
  const { rows: packCount } = await db.query('SELECT COUNT(*)::int AS n FROM ad_rate_packs');
  if (packCount[0].n === 0) {
    for (const level of ALL_LEVELS) {
      for (const [hours, cityPrice] of CITY_PACKS) {
        await db.query('INSERT INTO ad_rate_packs (level, hours, price_cents) VALUES ($1, $2, $3)', [
          level, hours, Math.round((cityPrice * LEVEL_FACTOR[level]) / 100) * 100,
        ]);
      }
    }
  }
  for (const [i, [key, name, description, formats, levels, maxLive, premium]] of PLACEMENTS.entries()) {
    await db.query(
      `INSERT INTO ad_placements (key, name, description, formats, allowed_levels, max_live_per_region, premium_percent, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (key) DO NOTHING`,
      [key, name, description, JSON.stringify(formats), JSON.stringify(levels ?? ALL_LEVELS), maxLive, premium, i * 10]
    );
  }

  // Regions: India → Tamil Nadu → the districts and cities shops are in today.
  const { rows: regionCount } = await db.query('SELECT COUNT(*)::int AS n FROM ad_regions');
  if (regionCount[0].n === 0) {
    const add = async (level, name, parentId, multiplier = 1) =>
      (await db.query('INSERT INTO ad_regions (level, name, parent_id, price_multiplier) VALUES ($1, $2, $3, $4) RETURNING id', [level, name, parentId, multiplier])).rows[0].id;
    const india = await add('country', 'India', null);
    const tn = await add('state', 'Tamil Nadu', india);
    for (const [district, multiplier] of [['Chennai', 1.5], ['Madurai', 1], ['Dindigul', 0.8]]) {
      const d = await add('district', district, tn, multiplier);
      await add('city', district, d, multiplier);
    }
  }

  const { rows: ruleCount } = await db.query('SELECT COUNT(*)::int AS n FROM ad_pricing_rules');
  if (ruleCount[0].n === 0) {
    const rules = [
      ['Deepavali season', 'seasonal', {}, 25, 10, '2026-11-01T00:00:00+05:30', '2026-11-11T00:00:00+05:30', true],
      ['Evening peak (6–10 pm)', 'peak', { fromHour: 18, toHour: 22 }, 15, 20, null, null, false],
      ['A week or more', 'volume', { minHours: 168 }, -10, 30, null, null, true],
      ['Three regions or more', 'multi_region', { minRegions: 3 }, -10, 40, null, null, true],
    ];
    for (const [name, kind, conditions, pct, priority, from, to, active] of rules) {
      await db.query(
        `INSERT INTO ad_pricing_rules (name, kind, conditions, adjust_percent, priority, starts_at, ends_at, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [name, kind, JSON.stringify(conditions), pct, priority, from, to, active]
      );
    }
  }

  const packages = [
    ['Basic', 'basic', 'A shop card in one city for a day.', 'city', 24, 99900, ['shop_card'], 1, 10],
    ['Growth', 'growth', 'Home banner and shop card in one city for a week.', 'city', 168, 499900, ['home_banner', 'shop_card'], 1, 20],
    ['Premium', 'premium', 'Home banner and festival section across a district for a week.', 'district', 168, 999900, ['home_banner', 'festival'], 2, 30],
    ['Enterprise', 'enterprise', 'Every placement across a state for a month.', 'state', 720, 4999900, PLACEMENTS.map((p) => p[0]), 1, 40],
  ];
  for (const [name, tier, description, level, hours, price, placements, maxRegions, sort] of packages) {
    await db.query(
      `INSERT INTO ad_packages (name, tier, description, level, hours, price_cents, placements, max_regions, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (name) DO NOTHING`,
      [name, tier, description, level, hours, price, JSON.stringify(placements), maxRegions, sort]
    );
  }
}

module.exports = { seedAdPricing, ALL_LEVELS };
