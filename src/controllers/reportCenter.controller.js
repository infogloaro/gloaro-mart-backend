const pool = require('../config/db');
const { GROUPS, REPORTS, BY_KEY } = require('../services/reports');
const { ReportError, runReport, describe, PAGE_SIZES, EXPORT_LIMIT, MAX_RANGE_DAYS } = require('../services/reports/engine');

/**
 * Admin → Reports (RP): one place for every report.
 *
 * GET /api/admin/report-center          the catalogue and the filter lists
 * GET /api/admin/report-center/:key     one page of a report
 *     ?from&to (YYYY-MM-DD, India days) &q &sort &dir &page &pageSize
 *     &<the report's own filters>; &all=1 reads up to 5000 rows for PDF / CSV.
 */

async function catalogue(req, res) {
  const [shops, categories, cities, brands] = await Promise.all([
    pool.query(`SELECT id, business_name AS name, city FROM vendor_profiles ORDER BY LOWER(business_name), id`),
    pool.query(`SELECT DISTINCT TRIM(category) AS name FROM products WHERE NULLIF(TRIM(category), '') IS NOT NULL ORDER BY 1`),
    pool.query(
      `SELECT DISTINCT INITCAP(TRIM(city)) AS name FROM (
         SELECT city FROM vendor_profiles UNION ALL SELECT city FROM addresses
       ) c WHERE NULLIF(TRIM(city), '') IS NOT NULL ORDER BY 1`
    ),
    pool.query(`SELECT id, name FROM brands ORDER BY LOWER(name)`),
  ]);
  const described = REPORTS.map(describe);
  res.json({
    groups: GROUPS.map((g) => ({ ...g, reports: described.filter((r) => r.group === g.key) })),
    options: {
      shops: shops.rows,
      categories: categories.rows.map((r) => r.name),
      cities: cities.rows.map((r) => r.name),
      brands: brands.rows,
    },
    pageSizes: PAGE_SIZES,
    exportLimit: EXPORT_LIMIT,
    maxRangeDays: MAX_RANGE_DAYS,
  });
}

async function run(req, res) {
  const def = BY_KEY.get(req.params.key);
  if (!def) return res.status(404).json({ message: 'No such report.' });
  try {
    const result = await runReport(pool, def, req.query, { all: req.query.all === '1' });
    res.json(result);
  } catch (e) {
    if (e instanceof ReportError) return res.status(e.status).json({ message: e.message });
    throw e;
  }
}

module.exports = { catalogue, run };
