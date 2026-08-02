import { DistillerLlm } from './distiller-v2';
import { PiiLlm } from './pii-redactor';

// Mocks deterministas del destilador y del detector de PII, para poder ejercitar
// /internal/distill-candidates contra datos sembrados sin gastar llamadas a Gemini.
//
// USO EXCLUSIVO en tests (NODE_ENV==='test'). Prohibido como fallback en runtime — mismo
// criterio que MockEmbeddingsClient: un destilador simulado en producción llenaría
// okf_concepts de conceptos de mentira que parecerían corpus real.

export class MockDistillerLlm implements DistillerLlm {
  async generate(prompt: string): Promise<string> {
    // El título deriva del source_ref del prompt para que dos candidates distintos no colisionen
    // de slug (mismo truco que makeFixedDistillerLlm en candidate-poller.test.ts).
    const match = prompt.match(/source_ref:\s*(\S+)/);
    const ref = match ? match[1] : 'unknown';

    return JSON.stringify({
      type: 'Insight',
      title: `Concepto simulado ${ref}`,
      description: 'Generado por MockDistillerLlm; no es conocimiento real.',
      tags: ['c-comercial', 'prueba'],
      timestamp: '2026-07-01T10:00:00.000Z',
      sources: [ref],
      confidence: 'draft',
      pii: 'clean',
      altitude: 2,
      body: 'Cuerpo simulado para ejercitar la ruta de destilado de punta a punta.',
    });
  }
}

export class NoopPiiLlm implements PiiLlm {
  async detectSpans() {
    return [];
  }
}
