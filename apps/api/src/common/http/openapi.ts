import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { PRODUCT_NAME } from '@verax/shared';

export const OPENAPI_PATH = 'docs';

/** A interface do Swagger precisa de script e estilo próprios; esta CSP mais aberta vale só para ela. */
const DOCS_HELMET_OPTIONS = {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
};

/**
 * Documentação OpenAPI, montada só em desenvolvimento (`configureApp` decide). Os schemas zod declarados
 * nas rotas viram JSON Schema pelo próprio @nestjs/swagger (Standard Schema).
 */
export function setupOpenApi(app: NestExpressApplication, prefix: string): void {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle(`${PRODUCT_NAME} API`).setVersion(prefix).build(),
  );

  app.use(`/${prefix}/${OPENAPI_PATH}`, helmet(DOCS_HELMET_OPTIONS));
  SwaggerModule.setup(OPENAPI_PATH, app, document, {
    useGlobalPrefix: true,
    jsonDocumentUrl: `${OPENAPI_PATH}/openapi.json`,
    yamlDocumentUrl: `${OPENAPI_PATH}/openapi.yaml`,
  });
}
