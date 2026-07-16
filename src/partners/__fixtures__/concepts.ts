// KL0-W2 — fixtures del validador OKF de 3 niveles (validator.test.ts).
// Markdown crudo (frontmatter + body), tal como llegaría desde el editor/panel.

export const PERFECT_N3_CONCEPT = `---
type: Proceso
title: Onboarding de clientes nuevos
description: Pasos para dar de alta a un cliente nuevo en el despacho.
tags: [l-legal, onboarding, clientes]
timestamp: 2026-07-01T10:00:00Z
sources: [doc:sha256:${'a'.repeat(64)}]
confidence: consolidated
pii: clean
altitude: 3
curator:
  legal_name: Bufete Demo S.C.
  responsible: Ana Ramírez
---

# Contexto

Este proceso aplica a todo cliente nuevo referido por el área comercial.

# Pasos

1. Verificar identidad.
2. Firmar carta de servicios.
3. Entregar carpeta de bienvenida impresa.

# Citations

[1] Manual interno de onboarding.
`;

export const MISSING_TYPE_CONCEPT = `---
title: Concepto sin type
description: Falta el campo type en el frontmatter.
tags: [l-legal]
timestamp: 2026-07-01T10:00:00Z
sources: [doc:sha256:${'b'.repeat(64)}]
confidence: draft
pii: clean
altitude: 2
---

Cuerpo mínimo sin mayor relevancia.
`;

export const TAGS_OUT_OF_ORDER_CONCEPT = `---
type: Insight
title: Objeciones de precio recurrentes
description: Objeciones más comunes al precio y cómo resolverlas.
tags: [precio, objeciones, c-comercial]
timestamp: 2026-07-01T10:00:00Z
sources: [doc:sha256:${'c'.repeat(64)}]
confidence: draft
pii: clean
altitude: 2
---

# Contexto

El sistema c-comercial aparece en tags[2], no en tags[0].
`;

export const BAD_SOURCE_REF_CONCEPT = `---
type: Insight
title: Fuente malformada
description: sources trae un valor que no matchea SourceRefSchema.
tags: [c-comercial]
timestamp: 2026-07-01T10:00:00Z
sources: ["no-es-un-source-ref"]
confidence: draft
pii: clean
altitude: 1
---

Cuerpo de prueba.
`;

export const EXTERNAL_LINK_CONCEPT = `---
type: Insight
title: Concepto con link externo
description: Cross-link a otro aliado, debe fallar N3.
tags: [c-comercial]
timestamp: 2026-07-01T10:00:00Z
sources: [doc:sha256:${'d'.repeat(64)}]
confidence: consolidated
pii: clean
altitude: 1
curator:
  legal_name: Bufete Demo S.C.
  responsible: Ana Ramírez
---

Ver [otro aliado](@otro-aliado/c-comercial/precio.md) para más contexto.
`;

export const PENDING_LINK_CONCEPT = `---
type: Insight
title: Concepto con link pendiente
description: Cross-link intra-paquete a un concepto que aún no existe en packagePaths.
tags: [c-comercial]
timestamp: 2026-07-01T10:00:00Z
sources: [doc:sha256:${'e'.repeat(64)}]
confidence: consolidated
pii: clean
altitude: 1
curator:
  legal_name: Bufete Demo S.C.
  responsible: Ana Ramírez
---

Ver [otro concepto](/mismo-paquete/otro.md) para más contexto.
`;

export function draftConfidenceConcept(): string {
  return `---
type: Insight
title: Concepto en borrador
description: confidence draft, valido en staging pero no al publicar.
tags: [c-comercial]
timestamp: 2026-07-01T10:00:00Z
sources: [doc:sha256:${'f'.repeat(64)}]
confidence: draft
pii: clean
altitude: 1
curator:
  legal_name: Bufete Demo S.C.
  responsible: Ana Ramírez
---

Cuerpo de prueba.
`;
}

export function conceptWithBodyLength(chars: number): string {
  const body = 'x'.repeat(chars);
  return `---
type: Insight
title: Concepto con cuerpo largo
description: Prueba de límite de longitud del body.
tags: [c-comercial]
timestamp: 2026-07-01T10:00:00Z
sources: [doc:sha256:${'0'.repeat(64)}]
confidence: draft
pii: clean
altitude: 1
---

${body}
`;
}

export const RELATIVE_LINK_CONCEPT = `---
type: Insight
title: Concepto con link relativo
description: El link usa forma relativa en vez de bundle-relativa.
tags: [c-comercial]
timestamp: 2026-07-01T10:00:00Z
sources: [doc:sha256:${'1'.repeat(64)}]
confidence: draft
pii: clean
altitude: 1
---

Ver [nota relacionada](./nota-relacionada.md) para más contexto.
`;

export const NO_FRONTMATTER_CONCEPT = `Este archivo no tiene bloque de frontmatter en absoluto.
`;
