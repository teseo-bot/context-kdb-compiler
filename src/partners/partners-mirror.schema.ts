// espejo de contracts/src/partners.ts — mantener sincronizado
//
// Motivo: igual que src/infrastructure/concept-frontmatter.schema.ts — @teseo/contracts
// (/Users/teseohome/Teseo_AI/contracts) no es una dependencia npm del compiler; un import
// relativo (`../../../contracts/src/partners`) rompe `tsc --noEmit` con TS6059 ("File is not
// under 'rootDir'"). Por eso se duplican aquí SOLO los schemas que el validador KL0-W2
// (src/partners/validator.ts) necesita: PartnerConceptFrontmatterSchema (curator + confidence
// restringido a nivel N3) y PartnerPathSchema. Copiado TEXTUALMENTE de contracts/src/partners.ts
// (PA0-W1, commit e5c1db8).
//
// NOTA (KL0-W2, decisión de mapeo reportada): PartnerConceptFrontmatterSchema.extend({...})
// fija `confidence` a un enum ESTRICTO ('reviewed'|'consolidated'), sin 'draft'. El validador
// (validator.ts) NO llama a `PartnerConceptFrontmatterSchema.safeParse(data)` completo para la
// regla de confidence — porque DISEÑO-Knowledge-Lab.md §2 exige que 'draft' sea válido cuando
// `forPublish` es false, lo cual esta forma estricta del schema nunca permitiría (contradicción
// entre el contrato Zod congelado y el comportamiento condicional pedido — documentada también
// en validator.ts). El validador solo reutiliza el sub-schema `.shape.curator` de aquí para la
// regla `n3-curator`, y aplica la regla de `confidence` de forma condicional por separado.

import { z } from 'zod';
import { ConceptFrontmatterSchema } from '../infrastructure/concept-frontmatter.schema';

export const PartnerConceptFrontmatterSchema = ConceptFrontmatterSchema.extend({
  curator: z.object({
    legal_name: z.string().min(3).max(160),
    responsible: z.string().min(3).max(120),
  }),
  confidence: z.enum(['reviewed', 'consolidated']),
});
export type PartnerConceptFrontmatter = z.infer<typeof PartnerConceptFrontmatterSchema>;

// Exportado por completitud del espejo (instrucción KL0-W2). No se usa todavía dentro de
// validator.ts: la WU KL0-W2, tal como fue encargada, no incluye una regla de conformidad de
// `filename`/path propio contra PartnerPathSchema entre sus bullets de N3 (solo curator,
// confidence, cross-links). Queda disponible para cuando se decida añadir esa regla (candidata
// natural: `n3-path`), sin inventarla aquí.
export const PartnerPathSchema = z.string().regex(
  /^@[a-z0-9][a-z0-9-]{2,39}\/(h-talento-humano|o-operaciones|c-comercial|f-finanzas|l-legal|i-innovacion|t-tecnologia)\/[a-z0-9-]{1,60}\.md$/,
  'path de aliado inválido: @{partner_slug}/{system}/{slug}.md'
);
