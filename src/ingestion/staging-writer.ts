// K4-W2 (BACKEND §A7): escribe un DraftConcept validado a `_staging/{YYYY-MM-DD}/{draft_id}.md`
// vía BundleStore.write (actor 'compiler-v2', accion 'draft'). NO inserta provenance — eso
// ocurre al aplicar el merge en V3 (ver BACKEND §C1 paso 5). Aquí solo se serializa y escribe;
// marcar el candidate como 'drafted' es responsabilidad del caller (candidate-poller.ts).

import matter from 'gray-matter';
import { BundleStore } from '../infrastructure/bundle-store';
import { DraftConcept } from '../infrastructure/concept-frontmatter.schema';

/**
 * writeDraftToStaging: serializa frontmatter+body a Markdown (YAML frontmatter vía
 * gray-matter.stringify) y lo escribe en `_staging/{today}/{draft_id}.md` a través de
 * `store.write` (que valida el frontmatter con ConceptFrontmatterSchema, ya que los drafts
 * en _staging SÍ se validan). Devuelve el path escrito.
 */
export async function writeDraftToStaging(
  store: BundleStore,
  draft: DraftConcept,
  today: string
): Promise<string> {
  const content = matter.stringify(draft.body, draft.frontmatter);
  const path = `_staging/${today}/${draft.draft_id}.md`;

  await store.write(path, content, {
    actor: 'compiler-v2',
    accion: 'draft',
  });

  return path;
}
