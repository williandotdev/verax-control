import type { VersionKind } from '@/lib/api';
import type { ValidationIssue } from '@/lib/api-types';
import { getAt } from '@/lib/paths';

/**
 * A forma de um documento importado de arquivo, antes de ele chegar ao formulário: cada bloco que a tela percorre
 * precisa ser objeto, e cada lista, uma lista de objetos. O que não estiver assim vira um problema no caminho (como
 * os da API), mostrado ao lado do campo e no resumo; o formulário desenha o resto, e a validação completa continua
 * sendo a da API na gravação. Nada é corrigido em silêncio.
 */
interface Shape {
  /** Blocos que, se existirem, têm de ser objetos. */
  objects: readonly string[];
  /** Listas que, se existirem, têm de ser listas de objetos; `itemObjects` são objetos dentro de cada item. */
  lists: readonly { path: string; itemObjects?: readonly string[] }[];
}

const SIZES = ['P', 'M', 'G'] as const;

const SHAPES: Readonly<Record<VersionKind, Shape>> = {
  'cost-models': {
    objects: [
      'exchange',
      'infrastructure',
      'infrastructure.sizes',
      ...SIZES.map((size) => `infrastructure.sizes.${size}`),
      'infrastructure.agents',
      'paymentFees',
      'paymentFees.card',
      'paymentFees.boleto',
      'taxes',
      'support',
      'support.hours',
      'fixedCosts',
      'margins',
    ],
    lists: [
      { path: 'taxes.rates' },
      { path: 'support.hours.perVolumeBand' },
      { path: 'fixedCosts.items' },
      { path: 'sources' },
    ],
  },
  'pricing-tables': {
    objects: [
      'sizing',
      'modes',
      ...(['managed', 'self_hosted'] as const).flatMap((mode) => [
        `modes.${mode}`,
        `modes.${mode}.environment`,
        ...SIZES.map((size) => `modes.${mode}.environment.${size}`),
        `modes.${mode}.setup`,
      ]),
      'cloudAccounts',
      'cloudAccounts.additional',
      'volume',
      'agents',
      'agents.pack',
      'history',
      'prioritySupport',
      'users',
    ],
    lists: [
      { path: 'sizing.sizes' },
      { path: 'volume.bands' },
      { path: 'history.extended' },
      { path: 'presets', itemObjects: ['configuration'] },
    ],
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function described(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'lista';
  return typeof value;
}

function segments(path: string): string[] {
  return path.split('.');
}

export function shapeIssues(kind: VersionKind, content: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const shape = SHAPES[kind];
  for (const path of shape.objects) {
    const value = getAt(content, segments(path));
    if (value !== undefined && !isRecord(value)) {
      issues.push({ path, message: `esperado um objeto, recebido ${described(value)}` });
    }
  }
  for (const list of shape.lists) {
    const value = getAt(content, segments(list.path));
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      issues.push({ path: list.path, message: `esperada uma lista, recebido ${described(value)}` });
      continue;
    }
    value.forEach((item: unknown, index) => {
      if (!isRecord(item)) {
        issues.push({
          path: `${list.path}.${index}`,
          message: `esperado um objeto, recebido ${described(item)}`,
        });
        return;
      }
      for (const nested of list.itemObjects ?? []) {
        const inner = getAt(item, segments(nested));
        if (inner !== undefined && !isRecord(inner)) {
          issues.push({
            path: `${list.path}.${index}.${nested}`,
            message: `esperado um objeto, recebido ${described(inner)}`,
          });
        }
      }
    });
  }
  return issues;
}

/** Os itens de uma lista do rascunho que são objetos (as prévias da tela ignoram o resto). */
export function recordsAt(content: unknown, path: readonly string[]): Record<string, unknown>[] {
  const value = getAt(content, path);
  return Array.isArray(value) ? value.filter(isRecord) : [];
}
