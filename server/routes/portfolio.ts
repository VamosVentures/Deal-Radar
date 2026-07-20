import { Router } from 'express';
import { z } from 'zod';
import { store } from '../lib/store';
import { wrap } from './helpers';
import { parseCsv, savePortfolio } from '../services/imports';
import { portfolioCompanySchema } from '../../shared/integrations';

export const portfolioRouter = Router();

portfolioRouter.get('/portfolio', wrap(async (_req, res) => {
  res.json({ portfolio: store.raw.portfolio });
}));

portfolioRouter.put('/portfolio', wrap(async (req, res) => {
  res.json(savePortfolio(req.body));
}));

portfolioRouter.post('/portfolio/company', wrap(async (req, res) => {
  const company = portfolioCompanySchema.parse(req.body);
  const rest = store.raw.portfolio.filter((p) => (p as { name?: string }).name?.toLowerCase() !== company.name.toLowerCase());
  store.raw.portfolio = [...rest, company];
  store.save();
  res.json({ ok: true, count: store.raw.portfolio.length });
}));

portfolioRouter.post('/portfolio/import-csv', wrap(async (req, res) => {
  const { csv } = z.object({ csv: z.string().min(10) }).parse(req.body);
  const rows = parseCsv(csv);
  let imported = 0;
  const skipped: { row: number; issues: string[] }[] = [];
  rows.forEach((row, i) => {
    const parsed = portfolioCompanySchema.safeParse({
      ...row,
      themes: row.themes ? row.themes.split('|').map((s) => s.trim()).filter(Boolean) : [],
      evidenceUrls: row.evidenceUrls ? row.evidenceUrls.split('|').map((s) => s.trim()).filter(Boolean) : [],
      partnershipThemes: row.partnershipThemes ? row.partnershipThemes.split('|').map((s) => s.trim()).filter(Boolean) : [],
      competitiveOverlapThemes: row.competitiveOverlapThemes ? row.competitiveOverlapThemes.split('|').map((s) => s.trim()).filter(Boolean) : [],
    });
    if (!parsed.success) {
      skipped.push({ row: i + 2, issues: parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`) });
      return;
    }
    store.raw.portfolio = [
      ...store.raw.portfolio.filter((p) => (p as { name?: string }).name?.toLowerCase() !== parsed.data.name.toLowerCase()),
      parsed.data,
    ];
    imported += 1;
  });
  store.save();
  res.json({ imported, skipped, total: rows.length });
}));
