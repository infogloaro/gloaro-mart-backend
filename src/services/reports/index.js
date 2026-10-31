/**
 * Admin → Reports catalogue: every report group, in menu order. A group with
 * no reports yet is listed as coming next, so the hub shows the whole plan.
 */
const sales = require('./sales');
const payments = require('./payments');
const tax = require('./tax');
const delivery = require('./delivery');
const cancellations = require('./cancellations');
const inventory = require('./inventory');
const shops = require('./shops');
const customers = require('./customers');
const marketing = require('./marketing');
const services = require('./services');

const GROUPS = [
  { key: 'sales', label: 'Sales & orders' },
  { key: 'payments', label: 'Payments & money' },
  { key: 'tax', label: 'Tax (GST)' },
  { key: 'delivery', label: 'Delivery' },
  { key: 'cancellations', label: 'Cancellations & returns' },
  { key: 'inventory', label: 'Products & inventory' },
  { key: 'shops', label: 'Shops (vendors)' },
  { key: 'customers', label: 'Customers' },
  { key: 'marketing', label: 'Marketing' },
  { key: 'services', label: 'Near Me services' },
  { key: 'support', label: 'Reviews & support' },
  { key: 'platform', label: 'Platform & admin' },
];

const REPORTS = [...sales.reports, ...payments.reports, ...tax.reports, ...delivery.reports, ...cancellations.reports, ...inventory.reports, ...shops.reports, ...customers.reports, ...marketing.reports, ...services.reports];
const BY_KEY = new Map(REPORTS.map((r) => [r.key, r]));

module.exports = { GROUPS, REPORTS, BY_KEY };
