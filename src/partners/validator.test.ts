// KL0-W2 — tests del validador OKF de 3 niveles (PLAN-KnowledgeLab-Epicas-KL.md, KL0-W2).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateConcept, validatePackage, applyQuickFix, ValidationFinding } from './validator';
import {
  PERFECT_N3_CONCEPT,
  MISSING_TYPE_CONCEPT,
  TAGS_OUT_OF_ORDER_CONCEPT,
  BAD_SOURCE_REF_CONCEPT,
  EXTERNAL_LINK_CONCEPT,
  PENDING_LINK_CONCEPT,
  draftConfidenceConcept,
  conceptWithBodyLength,
  RELATIVE_LINK_CONCEPT,
  NO_FRONTMATTER_CONCEPT,
} from './__fixtures__/concepts';

function errors(findings: ValidationFinding[]): ValidationFinding[] {
  return findings.filter(f => f.severity === 'error');
}

// --- [INV-KL5] pureza -------------------------------------------------------------------

test('[INV-KL5] validator.ts no importa módulos de I/O (pg, storage, server, fs)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'validator.ts'), 'utf-8');
  const forbidden: RegExp[] = [
    /from ['"]pg['"]/,
    /require\(['"]pg['"]\)/,
    /from ['"]@google-cloud\/storage['"]/,
    /from ['"]\.\.\/infrastructure\/storage-adapter['"]/,
    /from ['"]\.\.\/infrastructure\/bundle-store['"]/,
    /from ['"]\.\.\/server['"]/,
    /from ['"]\.\/server['"]/,
    /from ['"]node:fs['"]/,
    /from ['"]fs['"]/,
    /require\(['"]fs['"]\)/,
  ];
  for (const pattern of forbidden) {
    assert.equal(pattern.test(src), false, `validator.ts no debe matchear ${pattern}`);
  }
});

test('[INV-KL5] partners-mirror.schema.ts (dependencia de validator.ts) tampoco importa I/O', () => {
  const src = fs.readFileSync(path.join(__dirname, 'partners-mirror.schema.ts'), 'utf-8');
  assert.equal(/from ['"]pg['"]/.test(src), false);
  assert.equal(/from ['"]@google-cloud\/storage['"]/.test(src), false);
});

// --- N1 ----------------------------------------------------------------------------------

test('sin bloque de frontmatter → error n1-frontmatter-invalido, único finding', () => {
  const report = validateConcept(NO_FRONTMATTER_CONCEPT, { level: 'n2' });
  assert.equal(report.valid, false);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].rule_id, 'n1-frontmatter-invalido');
  assert.equal(report.findings[0].severity, 'error');
});

test('sin type → error n1-type-requerido', () => {
  const report = validateConcept(MISSING_TYPE_CONCEPT, { level: 'n2' });
  assert.equal(report.valid, false);
  assert.ok(errors(report.findings).some(f => f.rule_id === 'n1-type-requerido'));
});

// --- N2 ----------------------------------------------------------------------------------

test('concepto perfecto N3 → 0 findings, valid:true', () => {
  const report = validateConcept(PERFECT_N3_CONCEPT, { level: 'n3', forPublish: true });
  assert.deepEqual(report.findings, []);
  assert.equal(report.valid, true);
});

test('tags[0] no-sistema con sistema en tags[2] → error n2-tags-sistema con fix; applyQuickFix repara y re-validar queda limpio', () => {
  const report = validateConcept(TAGS_OUT_OF_ORDER_CONCEPT, { level: 'n2' });
  const finding = report.findings.find(f => f.rule_id === 'n2-tags-sistema');
  assert.ok(finding, 'debe reportar n2-tags-sistema');
  assert.equal(finding!.severity, 'error');
  assert.ok(finding!.fix, 'debe traer fix determinista (el sistema aparece en tags[2])');
  assert.equal(finding!.fix!.kind, 'set_field');

  // no debe duplicarse como n2-tags genérico
  assert.equal(report.findings.some(f => f.rule_id === 'n2-tags'), false);

  const fixed = applyQuickFix(TAGS_OUT_OF_ORDER_CONCEPT, finding!);
  assert.notEqual(fixed, TAGS_OUT_OF_ORDER_CONCEPT);

  const reValidated = validateConcept(fixed, { level: 'n2' });
  assert.equal(reValidated.findings.some(f => f.rule_id === 'n2-tags-sistema'), false);

  // idempotencia: aplicar el fix ya aplicado no debe cambiar nada
  const reFinding = report.findings.find(f => f.rule_id === 'n2-tags-sistema')!;
  const fixedTwice = applyQuickFix(fixed, reFinding);
  assert.equal(fixedTwice, fixed);
});

test('source_ref malformado → error n2-source-ref', () => {
  const report = validateConcept(BAD_SOURCE_REF_CONCEPT, { level: 'n2' });
  const finding = report.findings.find(f => f.rule_id === 'n2-source-ref');
  assert.ok(finding, 'debe reportar n2-source-ref');
  assert.equal(finding!.severity, 'error');
  assert.equal(report.valid, false);
});

test('body de 8500 caracteres → error n2-body-excede', () => {
  const md = conceptWithBodyLength(8500);
  const report = validateConcept(md, { level: 'n2' });
  const finding = report.findings.find(f => f.rule_id === 'n2-body-excede');
  assert.ok(finding, 'debe reportar n2-body-excede');
  assert.equal(finding!.severity, 'error');
});

test('body de 6500 caracteres → warn n2-body-largo (no error)', () => {
  const md = conceptWithBodyLength(6500);
  const report = validateConcept(md, { level: 'n2' });
  const finding = report.findings.find(f => f.rule_id === 'n2-body-largo');
  assert.ok(finding, 'debe reportar n2-body-largo');
  assert.equal(finding!.severity, 'warn');
  assert.equal(report.valid, true); // solo warn, sigue siendo válido
});

test('link relativo (./x.md) → warn n2-link-relativo con fix bundle-relativo, y el fix es idempotente', () => {
  const report = validateConcept(RELATIVE_LINK_CONCEPT, { level: 'n2' });
  const finding = report.findings.find(f => f.rule_id === 'n2-link-relativo');
  assert.ok(finding, 'debe reportar n2-link-relativo');
  assert.equal(finding!.severity, 'warn');
  assert.ok(finding!.fix);
  assert.equal(finding!.fix!.to, '/nota-relacionada.md');

  const fixed = applyQuickFix(RELATIVE_LINK_CONCEPT, finding!);
  assert.ok(fixed.includes('](/nota-relacionada.md)'));

  const fixedTwice = applyQuickFix(fixed, finding!);
  assert.equal(fixedTwice, fixed); // idempotente
});

// --- N3 ----------------------------------------------------------------------------------

test('link @otro-aliado/x.md → error n3-link-externo', () => {
  const report = validateConcept(EXTERNAL_LINK_CONCEPT, { level: 'n3', forPublish: true });
  const finding = report.findings.find(f => f.rule_id === 'n3-link-externo');
  assert.ok(finding, 'debe reportar n3-link-externo');
  assert.equal(finding!.severity, 'error');
  assert.equal(report.valid, false);
});

test('link /mismo-paquete/otro.md ausente de packagePaths → warn n3-link-pendiente', () => {
  const report = validateConcept(PENDING_LINK_CONCEPT, { level: 'n3', forPublish: true, packagePaths: [] });
  const finding = report.findings.find(f => f.rule_id === 'n3-link-pendiente');
  assert.ok(finding, 'debe reportar n3-link-pendiente');
  assert.equal(finding!.severity, 'warn');
});

test('link /mismo-paquete/otro.md presente en packagePaths → sin finding de cross-link', () => {
  const report = validateConcept(PENDING_LINK_CONCEPT, {
    level: 'n3',
    forPublish: true,
    packagePaths: ['/mismo-paquete/otro.md'],
  });
  assert.equal(report.findings.some(f => f.rule_id === 'n3-link-pendiente' || f.rule_id === 'n3-link-externo'), false);
});

test('confidence draft CON forPublish:true → error n3-confidence-draft', () => {
  const report = validateConcept(draftConfidenceConcept(), { level: 'n3', forPublish: true });
  const finding = report.findings.find(f => f.rule_id === 'n3-confidence-draft');
  assert.ok(finding, 'debe reportar n3-confidence-draft');
  assert.equal(finding!.severity, 'error');
  assert.equal(report.valid, false);
});

test('confidence draft SIN forPublish → ok (draft válido en staging)', () => {
  const report = validateConcept(draftConfidenceConcept(), { level: 'n3', forPublish: false });
  assert.equal(report.findings.some(f => f.rule_id === 'n3-confidence-draft'), false);
});

test('curator incompleto → error n3-curator', () => {
  const md = `---
type: Insight
title: Sin curator completo
description: Falta responsible en curator.
tags: [c-comercial]
timestamp: 2026-07-01T10:00:00Z
sources: [doc:sha256:${'2'.repeat(64)}]
confidence: consolidated
pii: clean
altitude: 1
curator:
  legal_name: Bufete Demo S.C.
---

Cuerpo de prueba.
`;
  const report = validateConcept(md, { level: 'n3' });
  const finding = report.findings.find(f => f.rule_id === 'n3-curator');
  assert.ok(finding, 'debe reportar n3-curator');
  assert.equal(finding!.severity, 'error');
});

// --- applyQuickFix genérico ---------------------------------------------------------------

test('applyQuickFix con rule_id sin reparación conocida devuelve el markdown intacto', () => {
  const finding: ValidationFinding = {
    rule_id: 'n2-source-ref',
    level: 'n2',
    severity: 'error',
    message_es: 'x',
  };
  assert.equal(applyQuickFix(PERFECT_N3_CONCEPT, finding), PERFECT_N3_CONCEPT);
});

test('title ausente + filename → fix set_field disponible; applyQuickFix asigna title', () => {
  const md = `---
type: Insight
description: Sin title, con filename para derivarlo.
tags: [c-comercial]
timestamp: 2026-07-01T10:00:00Z
sources: [doc:sha256:${'3'.repeat(64)}]
confidence: draft
pii: clean
altitude: 1
---

Cuerpo de prueba.
`;
  const report = validateConcept(md, { level: 'n2', filename: 'politica-de-vacaciones.md' });
  const finding = report.findings.find(f => f.rule_id === 'n2-title');
  assert.ok(finding);
  assert.ok(finding!.fix);
  assert.equal(finding!.fix!.value, 'Politica De Vacaciones');

  const fixed = applyQuickFix(md, finding!);
  const reValidated = validateConcept(fixed, { level: 'n2', filename: 'politica-de-vacaciones.md' });
  assert.equal(reValidated.findings.some(f => f.rule_id === 'n2-title'), false);
});

// --- timestamp normalize -------------------------------------------------------------------

test('timestamp no-ISO pero parseable → fix set_field normaliza a ISO 8601', () => {
  const md = `---
type: Insight
title: Timestamp raro
description: timestamp en formato no-ISO pero parseable por Date.parse.
tags: [c-comercial]
timestamp: 2026-07-08
sources: [doc:sha256:${'4'.repeat(64)}]
confidence: draft
pii: clean
altitude: 1
---

Cuerpo de prueba.
`;
  const report = validateConcept(md, { level: 'n2' });
  const finding = report.findings.find(f => f.rule_id === 'n2-timestamp');
  assert.ok(finding);
  assert.ok(finding!.fix);
  const fixed = applyQuickFix(md, finding!);
  const reValidated = validateConcept(fixed, { level: 'n2' });
  assert.equal(reValidated.findings.some(f => f.rule_id === 'n2-timestamp'), false);
});

// --- validatePackage -----------------------------------------------------------------------

test('validatePackage: index.md raíz sin frontmatter con estructura de lista → sin findings', () => {
  const files = [
    { path: 'index.md', markdown: '# Paquete Demo\n\n* [Concepto uno](c-comercial/uno.md) - descripción\n' },
    { path: 'c-comercial/uno.md', markdown: PERFECT_N3_CONCEPT },
  ];
  const reports = validatePackage(files, { level: 'n3', forPublish: true });
  const indexReport = reports.find(r => r.path === 'index.md')!;
  assert.deepEqual(indexReport.findings, []);
});

test('validatePackage: index.md sin estructura de lista → warn n1-index-estructura', () => {
  const files = [{ path: 'index.md', markdown: '# Paquete sin lista\n\nSolo prosa, sin bullets.\n' }];
  const reports = validatePackage(files, { level: 'n3' });
  const indexReport = reports[0];
  assert.ok(indexReport.findings.some(f => f.rule_id === 'n1-index-estructura'));
});

test('validatePackage: index.md NO raíz con frontmatter → warn n1-index-estructura', () => {
  const files = [
    {
      path: 'c-comercial/index.md',
      markdown: '---\ntitle: no debería llevar frontmatter\n---\n\n* [x](y.md) - y\n',
    },
  ];
  const reports = validatePackage(files, { level: 'n3' });
  assert.ok(reports[0].findings.some(f => f.rule_id === 'n1-index-estructura'));
});

test('validatePackage: log.md con encabezados de fecha válidos → sin findings', () => {
  const files = [
    {
      path: 'log.md',
      markdown: '# Directory Update Log\n\n## 2026-07-01\n* **Creation**: Concepto inicial.\n',
    },
  ];
  const reports = validatePackage(files, { level: 'n3' });
  assert.deepEqual(reports[0].findings, []);
});

test('validatePackage: log.md con encabezado de fecha mal formado → warn n1-log-fechas', () => {
  const files = [
    { path: 'log.md', markdown: '# Log\n\n## Julio 2026\n* Update: algo.\n' },
  ];
  const reports = validatePackage(files, { level: 'n3' });
  assert.ok(reports[0].findings.some(f => f.rule_id === 'n1-log-fechas'));
});

test('validatePackage: cross-link intra-paquete se resuelve automáticamente contra los paths de los otros archivos', () => {
  const conceptWithLink = `---
type: Insight
title: Con link a otro concepto del mismo paquete
description: El link debe resolverse contra los paths del propio paquete.
tags: [c-comercial]
timestamp: 2026-07-01T10:00:00Z
sources: [doc:sha256:${'5'.repeat(64)}]
confidence: consolidated
pii: clean
altitude: 1
curator:
  legal_name: Bufete Demo S.C.
  responsible: Ana Ramírez
---

Ver [otro concepto](/c-comercial/otro.md).
`;
  const files = [
    { path: 'c-comercial/uno.md', markdown: conceptWithLink },
    { path: 'c-comercial/otro.md', markdown: PERFECT_N3_CONCEPT },
  ];
  const reports = validatePackage(files, { level: 'n3', forPublish: true });
  const unoReport = reports.find(r => r.path === 'c-comercial/uno.md')!;
  assert.equal(unoReport.findings.some(f => f.rule_id === 'n3-link-pendiente' || f.rule_id === 'n3-link-externo'), false);
});
