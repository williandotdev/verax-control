import { z } from 'zod';
import { withPagination } from './pagination.js';

/**
 * Tipos de item da lista de proteção (T3.4): recursos e identidades que nunca recebem ação automática. Cada
 * tipo tem o formato do identificador conferido, para a comparação com os achados (T5.6) ser exata.
 */
export const PROTECTED_RESOURCE_TYPES = [
  'aws_account',
  'iam_user',
  'iam_role',
  'access_key',
  'ec2_instance',
  's3_bucket',
  'security_group',
  'ip_address',
] as const;
export type ProtectedResourceType = (typeof PROTECTED_RESOURCE_TYPES)[number];

const IAM_NAME = /^[\w+=,.@-]{1,128}$/;
const IAM_ARN = /^arn:aws(-cn|-us-gov)?:iam::\d{12}:(user|role)\/[\w+=,.@/-]{1,512}$/;

const IDENTIFIER_RULES: Readonly<Record<ProtectedResourceType, (value: string) => boolean>> = {
  aws_account: (value) => /^\d{12}$/.test(value),
  iam_user: (value) => IAM_NAME.test(value) || (IAM_ARN.test(value) && value.includes(':user/')),
  iam_role: (value) => IAM_NAME.test(value) || (IAM_ARN.test(value) && value.includes(':role/')),
  access_key: (value) => /^(AKIA|ASIA)[A-Z0-9]{16}$/.test(value),
  ec2_instance: (value) => /^i-[0-9a-f]{8,17}$/.test(value),
  s3_bucket: (value) => /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value),
  security_group: (value) => /^sg-[0-9a-f]{8,17}$/.test(value),
  ip_address: (value) =>
    [z.ipv4(), z.ipv6(), z.cidrv4(), z.cidrv6()].some((schema) => schema.safeParse(value).success),
};

export function isValidProtectedIdentifier(type: ProtectedResourceType, value: string): boolean {
  return IDENTIFIER_RULES[type](value);
}

/** Texto livre curto, sem caractere de controle (vai para a tela e para a auditoria). */
export const plainText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127), {
      error: 'caractere de controle não é permitido',
    });

export const protectedResourceCreateSchema = z
  .strictObject({
    type: z.enum(PROTECTED_RESOURCE_TYPES),
    identifier: z.string().trim().min(1).max(600),
    reason: plainText(500),
  })
  .refine((input) => isValidProtectedIdentifier(input.type, input.identifier), {
    error: 'identificador fora do formato do tipo',
    path: ['identifier'],
  });
export type ProtectedResourceCreate = z.infer<typeof protectedResourceCreateSchema>;

/** Só o motivo muda: outro identificador é outro item. */
export const protectedResourceUpdateSchema = z.strictObject({ reason: plainText(500) });
export type ProtectedResourceUpdate = z.infer<typeof protectedResourceUpdateSchema>;

export const protectedResourceListQuerySchema = withPagination({
  type: z.enum(PROTECTED_RESOURCE_TYPES).optional(),
});
export type ProtectedResourceListQuery = z.infer<typeof protectedResourceListQuerySchema>;

/** Quem incluiu ou criou um item, como aparece para o cliente. */
export const authorSchema = z.strictObject({ id: z.string(), name: z.string() });

export const protectedResourceSchema = z.strictObject({
  id: z.uuid(),
  type: z.enum(PROTECTED_RESOURCE_TYPES),
  identifier: z.string(),
  reason: z.string(),
  createdBy: authorSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ProtectedResource = z.infer<typeof protectedResourceSchema>;
