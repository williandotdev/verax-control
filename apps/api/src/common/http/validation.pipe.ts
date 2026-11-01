import {
  type ArgumentMetadata,
  Injectable,
  InternalServerErrorException,
  StandardSchemaValidationPipe,
  type StandardSchemaValidationPipeOptions,
} from '@nestjs/common';
import { ValidationException, type ValidationIssue } from './api-error.js';

type SchemaIssue = Parameters<
  NonNullable<StandardSchemaValidationPipeOptions['exceptionFactory']>
>[0][number];

/** Tipos de entrada que só chegam ao handler depois de validados por um schema. */
const INPUTS_REQUIRING_SCHEMA = new Set<ArgumentMetadata['type']>(['body', 'query', 'param']);

function toIssue(issue: SchemaIssue): ValidationIssue {
  const path = (issue.path ?? [])
    .map((segment) => String(typeof segment === 'object' ? segment.key : segment))
    .join('.');
  const code = (issue as { code?: unknown }).code;
  return { path, code: typeof code === 'string' ? code : 'invalid', message: issue.message };
}

/**
 * Validação global de entrada com schemas zod declarados na rota:
 * `@Body({ schema })`, `@Query({ schema })`, `@Param('id', { schema })`.
 *
 * Negação por padrão: corpo, query ou parâmetro de rota sem schema não chega ao handler (500 e log),
 * e o meta-teste de rotas falha no CI antes disso. Chaves `__proto__`/`constructor` são removidas
 * antes da validação (proteção contra prototype pollution, feita pelo pipe base do Nest).
 */
@Injectable()
export class AppValidationPipe extends StandardSchemaValidationPipe {
  constructor() {
    super({
      transform: true,
      exceptionFactory: (issues) => new ValidationException(issues.map(toIssue)),
    });
  }

  override async transform<T = unknown>(value: T, metadata: ArgumentMetadata): Promise<T> {
    if (!metadata.schema && INPUTS_REQUIRING_SCHEMA.has(metadata.type)) {
      throw new InternalServerErrorException(`Rota sem schema de validação para ${metadata.type}`);
    }
    return super.transform(value, metadata);
  }
}
