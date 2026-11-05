import { createContext, useContext } from 'react';
import type { ValidationIssue } from '@/lib/api-types';
import { appendAt, getAt, type Path, pathKey, removeAt, setAt } from '@/lib/paths';

/**
 * O rascunho em edição: um documento JSON inteiro (a tabela de preços ou o modelo de custos), os problemas que a API
 * apontou na última gravação (`details.issues`, por caminho) e se a versão ainda pode mudar. Cada campo lê e grava o
 * seu caminho; a validação de verdade é a da API (o mesmo zod da publicação), e a tela só mostra onde.
 */
export interface FormState {
  value: unknown;
  onChange: (next: unknown) => void;
  issues: ReadonlyMap<string, readonly string[]>;
  readOnly: boolean;
}

export const FormContext = createContext<FormState | null>(null);

/** Agrupa os problemas por caminho (um campo pode ter mais de um). */
export function issuesByPath(issues: readonly ValidationIssue[]): ReadonlyMap<string, readonly string[]> {
  const map = new Map<string, string[]>();
  for (const issue of issues) map.set(issue.path, [...(map.get(issue.path) ?? []), issue.message]);
  return map;
}

function useForm(): FormState {
  const state = useContext(FormContext);
  if (state === null) throw new Error('campo fora de um DraftForm');
  return state;
}

/** O id do controle de um caminho: o resumo de erros leva o foco até ele. */
export function fieldId(path: Path): string {
  return `campo-${pathKey(path)}`;
}

export interface FieldBinding {
  id: string;
  value: unknown;
  set: (next: unknown) => void;
  issues: readonly string[];
  readOnly: boolean;
}

export function useField(path: Path): FieldBinding {
  const form = useForm();
  const key = pathKey(path);
  return {
    id: fieldId(path),
    value: getAt(form.value, path),
    set: (next) => form.onChange(setAt(form.value, path, next)),
    issues: form.issues.get(key) ?? [],
    readOnly: form.readOnly,
  };
}

/** Uma lista do documento (faixas, alíquotas, custos fixos...): os itens, acrescentar e tirar. */
export function useList(path: Path): {
  items: readonly unknown[];
  append: (item: unknown) => void;
  remove: (index: number) => void;
  issues: readonly string[];
  readOnly: boolean;
} {
  const form = useForm();
  const list = getAt(form.value, path);
  return {
    items: Array.isArray(list) ? list : [],
    append: (item) => form.onChange(appendAt(form.value, path, item)),
    remove: (index) => form.onChange(removeAt(form.value, path, index)),
    issues: form.issues.get(pathKey(path)) ?? [],
    readOnly: form.readOnly,
  };
}

/** Lê o documento inteiro (prévias calculadas na hora, como o custo do nó por porte). */
export function useDraftValue(): unknown {
  return useForm().value;
}

/** Troca um pedaço do documento de uma vez (ligar ou desligar um bloco opcional, como a implantação). */
export function useSetter(): (path: Path, next: unknown) => void {
  const form = useForm();
  return (path, next) => form.onChange(setAt(form.value, path, next));
}
