import { loadCompanies, loadStealthFounders } from '../src/data/loader';
import { scoreCompany } from '../src/lib/scoring';

const companies = loadCompanies();
const stealth = loadStealthFounders();
console.log(`OK ${companies.length} companies passed Zod validation`);
console.log(`OK ${stealth.length} stealth founders passed Zod validation`);

const scored = companies.map((c) => ({ c, fit: scoreCompany(c) })).sort((a, b) => b.fit.score - a.fit.score);
for (const { c, fit } of scored) {
  if (fit.score < 1 || fit.score > 10) throw new Error(`Score out of range for ${c.name}`);
  const sum = fit.components.reduce((s, x) => s + x.points, 0);
  if (sum !== fit.totalPoints) throw new Error(`Component sum mismatch for ${c.name}`);
}
console.log('OK all scores in 1.0-10.0 range, breakdowns sum correctly');
console.log('\nTop 10 by Vamos Fit Score:');
scored.slice(0, 10).forEach(({ c, fit }, i) =>
  console.log(`  ${String(i + 1).padStart(2)}. ${fit.score.toFixed(1)}  ${c.name} (${c.vertical}, ${c.stage}, ${c.state})${fit.exceptions.length ? '  [FLAG] ' + fit.exceptions.map(e => e.flag).join(',') : ''}`));

const flagged = scored.filter(s => s.fit.exceptions.length > 0);
console.log(`\nOK ${flagged.length} companies carry policy-exception flags (flagged, not rejected):`);
flagged.forEach(({ c, fit }) => console.log(`  - ${c.name}: ${fit.exceptions.map(e => e.flag).join(', ')} -- score still ${fit.score.toFixed(1)}`));
