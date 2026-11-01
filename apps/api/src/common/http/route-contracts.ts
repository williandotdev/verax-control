import type { INestApplication } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants.js';
import { RouteParamtypes } from '@nestjs/common/internal';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { z } from 'zod';
import {
  AUTHENTICATED_KEY,
  IS_PUBLIC_KEY,
  PERMISSIONS_KEY,
  SELF_MANAGED_KEY,
} from '../../auth/decorators.js';

interface RouteArgument {
  index: number;
  data?: unknown;
  schema?: unknown;
}

export interface RouteContractViolation {
  route: string;
  problem: string;
}

const VALIDATED_INPUTS: ReadonlyMap<number, string> = new Map([
  [RouteParamtypes.BODY, 'body'],
  [RouteParamtypes.QUERY, 'query'],
  [RouteParamtypes.PARAM, 'param'],
]);

/** Encontra objetos zod que aceitam chaves desconhecidas, em qualquer profundidade do schema. */
export function findNonStrictObjects(schema: z.ZodType, path = '$', seen = new Set<z.ZodType>()): string[] {
  if (seen.has(schema)) return [];
  seen.add(schema);

  const def = schema._zod.def as unknown as Record<string, unknown> & { type: string };
  const children: [string, unknown][] = [];

  switch (def.type) {
    case 'object': {
      const catchall = def['catchall'] as z.ZodType | undefined;
      const strict = catchall?._zod.def.type === 'never';
      for (const [key, value] of Object.entries(def['shape'] as Record<string, unknown>)) {
        children.push([`${path}.${key}`, value]);
      }
      const nested = children.flatMap(([childPath, child]) =>
        findNonStrictObjects(child as z.ZodType, childPath, seen),
      );
      return strict ? nested : [path, ...nested];
    }
    case 'array':
      children.push([`${path}[]`, def['element']]);
      break;
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'readonly':
    case 'catch':
    case 'nonoptional':
      children.push([path, def['innerType']]);
      break;
    case 'pipe':
      children.push([path, def['in']]);
      break;
    case 'union':
      for (const option of def['options'] as unknown[]) children.push([path, option]);
      break;
    case 'intersection':
      children.push([path, def['left']], [path, def['right']]);
      break;
    case 'record':
      children.push([`${path}[*]`, def['valueType']]);
      break;
    case 'tuple':
      (def['items'] as unknown[]).forEach((item, i) => children.push([`${path}[${i}]`, item]));
      break;
    default:
      break;
  }
  return children.flatMap(([childPath, child]) => findNonStrictObjects(child as z.ZodType, childPath, seen));
}

/**
 * Percorre todas as rotas registradas e lista as que violam o contrato de entrada:
 * - corpo, query e parâmetro de rota precisam declarar `schema`;
 * - corpo e query são validados por inteiro (`@Body({ schema })`, não `@Body('campo')`);
 * - todo objeto do schema é estrito (rejeita chaves desconhecidas).
 */
export function findRouteContractViolations(app: INestApplication): RouteContractViolation[] {
  const discovery = app.get(DiscoveryService);
  const scanner = app.get(MetadataScanner);
  const violations: RouteContractViolation[] = [];

  for (const wrapper of discovery.getControllers()) {
    const instance: unknown = wrapper.instance;
    const metatype = wrapper.metatype;
    if (typeof instance !== 'object' || instance === null || !metatype) continue;
    const prototype = Object.getPrototypeOf(instance) as object;

    for (const methodName of scanner.getAllMethodNames(prototype)) {
      const handler = (prototype as Record<string, unknown>)[methodName];
      if (typeof handler !== 'function' || Reflect.getMetadata(PATH_METADATA, handler) === undefined)
        continue;
      if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue;

      const route = `${metatype.name}.${methodName}`;
      const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, metatype, methodName) ?? {}) as Record<
        string,
        RouteArgument
      >;

      for (const [key, argument] of Object.entries(args)) {
        const kind = VALIDATED_INPUTS.get(Number(key.split(':')[0]));
        if (!kind) continue;

        if (!(argument.schema instanceof z.ZodType)) {
          violations.push({ route, problem: `${kind} sem schema zod` });
          continue;
        }
        if (kind !== 'param' && argument.data !== undefined) {
          violations.push({
            route,
            problem: `${kind} extraído por campo (${JSON.stringify(argument.data)}); valide o objeto inteiro`,
          });
        }
        for (const path of findNonStrictObjects(argument.schema)) {
          violations.push({ route, problem: `${kind}: objeto não estrito em ${path}` });
        }
      }
    }
  }
  return violations;
}

export interface RoutePolicy {
  route: string;
  isPublic: boolean;
  selfManaged: boolean;
  permissions: string[];
  authenticated: boolean;
}

/** Lista cada rota com as marcações que relaxam a negação por padrão (`@Public`, `@SelfManaged`). */
export function listRoutePolicies(app: INestApplication): RoutePolicy[] {
  const discovery = app.get(DiscoveryService);
  const scanner = app.get(MetadataScanner);
  const policies: RoutePolicy[] = [];

  for (const wrapper of discovery.getControllers()) {
    const instance: unknown = wrapper.instance;
    const metatype = wrapper.metatype;
    if (typeof instance !== 'object' || instance === null || !metatype) continue;
    const prototype = Object.getPrototypeOf(instance) as object;

    for (const methodName of scanner.getAllMethodNames(prototype)) {
      const handler = (prototype as Record<string, unknown>)[methodName];
      if (typeof handler !== 'function' || Reflect.getMetadata(METHOD_METADATA, handler) === undefined)
        continue;
      const read = (key: string): unknown =>
        Reflect.getMetadata(key, handler) ?? Reflect.getMetadata(key, metatype);
      policies.push({
        route: `${metatype.name}.${methodName}`,
        isPublic: read(IS_PUBLIC_KEY) === true,
        selfManaged: read(SELF_MANAGED_KEY) !== undefined,
        permissions: (read(PERMISSIONS_KEY) as string[] | undefined) ?? [],
        authenticated: read(AUTHENTICATED_KEY) === true,
      });
    }
  }
  return policies;
}
