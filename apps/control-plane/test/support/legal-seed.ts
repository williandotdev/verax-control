import { COLLECTIONS } from '../../src/firestore/collections.js';
import type { DocumentStore } from '../../src/firestore/document-store.js';
import { sha256Hex } from '../../src/legal/legal-store.js';
import { LEGAL_KINDS, type LegalKind, legalTextDocumentSchema } from '../../src/legal/legal.schema.js';

/** Um texto FICTÍCIO, só para os testes: nada aqui é o texto de verdade (que fica fora do repositório). */
export function fictitiousLegalText(kind: LegalKind, version: string): string {
  return `# Texto de teste (${kind})\n\nVersão ${version}, fictícia, só para os testes.\n`;
}

/**
 * Grava a mesma versão dos três textos legais já publicada direto no banco (sem auditoria, para não misturar com a do
 * teste), em `publishedAt`. Os testes do console publicam pela API; os do site e do checkout só precisam das vigentes.
 */
export async function seedPublishedLegalTexts(
  documents: DocumentStore,
  version: string,
  publishedAt: Date,
  kinds: readonly LegalKind[] = LEGAL_KINDS,
): Promise<void> {
  await documents.runTransaction((tx) => {
    for (const kind of kinds) {
      const content = fictitiousLegalText(kind, version);
      const document = legalTextDocumentSchema.parse({
        status: 'published',
        content,
        publishedAt,
        publishedBy: 'responsavel@verax.example',
        contentSha256: sha256Hex(content),
        createdAt: publishedAt,
        createdBy: 'responsavel@verax.example',
        updatedAt: publishedAt,
        updatedBy: 'responsavel@verax.example',
      });
      tx.set(COLLECTIONS.legalVersions(kind), version, { ...document });
    }
    return Promise.resolve();
  });
}
