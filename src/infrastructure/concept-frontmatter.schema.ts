// Duplicado consciente de contracts/src/okf.ts — unificar cuando contracts sea dependencia npm
//
// Motivo: @teseo/contracts (/Users/teseohome/Teseo_AI/contracts) no es una dependencia npm del
// compiler. Un import relativo (`../../../contracts/src/okf`) rompe `tsc --noEmit` con
// TS6059 ("File is not under 'rootDir'") porque el tsconfig del compiler no declara rootDir
// explícito y TS lo infiere a partir de los archivos incluidos bajo src/. Verificado localmente:
// agregar el import relativo produce exactamente ese error. Por eso se duplica aquí el único
// schema que esta WU necesita (ConceptFrontmatterSchema + su dependencia SourceRefSchema),
// copiado TEXTUALMENTE de TRD-OKF-Cerebro-Virtual.md §4 / contracts/src/okf.ts.

import { z } from 'zod';

export const HOCFLIT_SYSTEMS = [
  'h-talento-humano', 'o-operaciones', 'c-comercial',
  'f-finanzas', 'l-legal', 'i-innovacion', 't-tecnologia',
] as const;
export const HocflitSystemSchema = z.enum(HOCFLIT_SYSTEMS);

export const ConceptTypeSchema = z.enum([
  'Insight', 'Perfil', 'Politica', 'Proceso', 'Metrica', 'Riesgo', 'Fuente',
]);

export const SourceRefSchema = z.string().regex(
  /^(conv:[\w-]+|doc:sha256:[a-f0-9]{64}|db:[\w]+:[\w-]+|url:https?:\/\/\S+)$/,
  'source-ref inválido (ver TRD §3.1)'
);

export const ConceptFrontmatterSchema = z.object({
  type: ConceptTypeSchema,
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(240),
  tags: z.array(z.string()).min(1)
    .refine(t => (HOCFLIT_SYSTEMS as readonly string[]).includes(t[0]),
      'tags[0] debe ser un slug de sistema HOCFLIT'),
  timestamp: z.string().datetime(),
  sources: z.array(SourceRefSchema).min(1),
  confidence: z.enum(['draft', 'reviewed', 'consolidated']),
  pii: z.enum(['clean', 'redacted']),
  altitude: z.number().int().min(1).max(5),
  resource: z.string().url().optional(),
});
export type ConceptFrontmatter = z.infer<typeof ConceptFrontmatterSchema>;

// K4-W1: DraftConceptSchema — copiado TEXTUALMENTE de contracts/src/okf.ts (TRD §4).
// Añadido a este archivo (en vez de contracts) por el mismo motivo documentado arriba:
// contracts no es dependencia npm del compiler.
export const DraftConceptSchema = z.object({
  draft_id: z.string().uuid(),
  tenant_id: z.string().min(1),
  frontmatter: ConceptFrontmatterSchema,   // confidence SIEMPRE 'draft' aquí
  body: z.string().min(1).max(8000),
  target_path: z.string().regex(/^(h-talento-humano|o-operaciones|c-comercial|f-finanzas|l-legal|i-innovacion|t-tecnologia)\/[a-z0-9-]{1,60}\.md$/),
});
export type DraftConcept = z.infer<typeof DraftConceptSchema>;
