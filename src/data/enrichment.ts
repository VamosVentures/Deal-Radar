// ─────────────────────────────────────────────────────────────────
// SAMPLE ENRICHMENT — fictional websites and verified contact info
// merged into companies by the loader. Founder emails appear ONLY
// with an emailSource (how the address was verified); companies
// without enrichment simply have no website/email, which exercises
// the name-based duplicate check and the missing-recipient guard.
// ─────────────────────────────────────────────────────────────────

export interface CompanyEnrichment {
  website?: string;
  accelerator?: string;
  dateFirstSurfaced?: string;
  founders?: Record<string, { email?: string; emailSource?: string; linkedin?: string }>;
}

export const ENRICHMENT: Record<string, CompanyEnrichment> = {
  'c-solcare': {
    website: 'https://solcarehealth.example.com',
    dateFirstSurfaced: '2026-04-12',
    founders: {
      'Mariana Otero': {
        email: 'mariana@solcarehealth.example.com',
        emailSource: 'Company press-release media contact, Apr 2026',
        linkedin: 'https://linkedin.com/in/example-mariana-otero',
      },
    },
  },
  'c-cuadrilla': {
    website: 'https://cuadrilla.example.com',
    dateFirstSurfaced: '2026-03-02',
    founders: {
      'Emilio Zarate': {
        email: 'emilio@cuadrilla.example.com',
        emailSource: 'Listed on company About page, 2026',
        linkedin: 'https://linkedin.com/in/example-emilio-zarate',
      },
      'Sofía Zarate': { linkedin: 'https://linkedin.com/in/example-sofia-zarate' },
    },
  },
  'c-lienzo': {
    website: 'https://lienzocapital.example.com',
    dateFirstSurfaced: '2026-01-20',
    founders: {
      'Marco Delgado': {
        email: 'marco@lienzocapital.example.com',
        emailSource: 'Public speaker bio, Latino Capital Summit 2026',
      },
    },
  },
  'c-voltaria': {
    website: 'https://voltaria.example.com',
    dateFirstSurfaced: '2026-02-14',
    founders: {
      'Alejandra Montoya': {
        email: 'alejandra@voltaria.example.com',
        emailSource: 'Canary Media interview byline contact, Apr 2026',
        linkedin: 'https://linkedin.com/in/example-alejandra-montoya',
      },
    },
  },
  'c-remisa': {
    website: 'https://remisa.example.com',
    dateFirstSurfaced: '2026-04-28',
    founders: {
      'Camila Duarte': {
        email: 'camila@remisa.example.com',
        emailSource: 'TechCrunch profile contact line, Apr 2026',
        linkedin: 'https://linkedin.com/in/example-camila-duarte',
      },
    },
  },
  'c-tandacash': {
    website: 'https://tandacash.example.com',
    accelerator: 'SOMOS accelerator, 2025 cohort',
    dateFirstSurfaced: '2026-06-05',
    founders: {
      'Rosa Iglesias': {
        email: 'rosa@tandacash.example.com',
        emailSource: 'SOMOS accelerator public founder directory',
      },
    },
  },
  'c-neurolista': {
    website: 'https://neurolista.example.com',
    dateFirstSurfaced: '2026-05-11',
  },
  'c-heliotermica': {
    website: 'https://heliotermica.example.com',
    dateFirstSurfaced: '2026-03-30',
    founders: {
      'Renata Silva': { linkedin: 'https://linkedin.com/in/example-renata-silva' },
    },
  },
  'c-shiftrn': {
    website: 'https://shiftrn.example.com',
    accelerator: 'Techstars Health, 2025',
    dateFirstSurfaced: '2026-02-09',
    founders: {
      'Gabriel Mendes': {
        email: 'gabriel@shiftrn.example.com',
        emailSource: 'Techstars public founder profile',
      },
    },
  },
  'c-stablemesa': {
    website: 'https://stablemesa.example.com',
    dateFirstSurfaced: '2026-05-22',
  },
};
