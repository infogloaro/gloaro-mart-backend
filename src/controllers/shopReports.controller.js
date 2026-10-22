const shopReports = require('../services/shopReports');
const { recordAudit } = require('../services/auditLog');

/**
 * Wrong-shop-details reports (SB7): customers report a shop
 * (/api/vendors/:id/report), admins work the queue under Vendors
 * (/api/admin/vendors/reports, vendors permission).
 */
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof shopReports.ReportError) return res.status(err.status).json({ message: err.message });
    throw err;
  }
};

const listReasons = handle(async (req, res) => {
  res.json({ items: shopReports.REASONS });
});

const reportShop = handle(async (req, res) => {
  res.status(201).json(await shopReports.report(req.user.id, req.params.id, req.body || {}));
});

const getMyReport = handle(async (req, res) => {
  res.json({ report: await shopReports.myLatest(req.user.id, req.params.id) });
});

const adminListReports = handle(async (req, res) => {
  res.json(await shopReports.adminList(req.query));
});

const adminGetReport = handle(async (req, res) => {
  const report = await shopReports.adminGet(Number(req.params.reportId) || 0);
  if (!report) return res.status(404).json({ message: 'Report not found' });
  res.json(report);
});

const adminCloseReport = handle(async (req, res) => {
  const { closed, status, report } = await shopReports.adminClose(req.params.reportId, req.body || {}, req.user.id);
  await shopReports.notifyReporters(closed, status);
  await recordAudit({
    actorUserId: req.user.id,
    action: status === 'resolved' ? 'vendor.report_resolved' : 'vendor.report_dismissed',
    module: 'vendors',
    entityType: 'shop_report',
    entityId: report.id,
    previousValue: { status: 'open' },
    newValue: { status, note: report.resolutionNote, closedReportIds: closed.map((r) => r.id) },
  });
  res.json({ ...report, closedCount: closed.length });
});

module.exports = { listReasons, reportShop, getMyReport, adminListReports, adminGetReport, adminCloseReport };
