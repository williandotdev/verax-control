import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Injectable,
  Module,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { Public } from '../../src/auth/decorators.js';
import { z } from 'zod';
import { AuditContext } from '../../src/common/audit/audit-context.service.js';
import { PrismaService } from '../../src/common/prisma/prisma.service.js';

/** Nome que faz o service lançar erro depois de gravar: prova que a transação é desfeita. */
export const EXPLODE_AFTER_INSERT = 'explode-after-insert';
/** Tipo de recurso que um trigger só de teste recusa ao gravar a auditoria. */
export const FORCE_AUDIT_FAILURE = 'force-audit-failure';

/** A tabela `widget_probe` é criada pelo globalSetup, só no banco de teste. */
interface Widget {
  id: string;
  name: string;
}

const createWidgetSchema = z.strictObject({
  name: z.string().min(1).max(100),
  password: z.string().optional(),
  notes: z.string().optional(),
});
const renameWidgetSchema = z.strictObject({ name: z.string().min(1).max(100) });

@Injectable()
class WidgetProbeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditContext,
  ) {}

  async create(input: z.infer<typeof createWidgetSchema>): Promise<Widget> {
    const [widget] = await this.prisma.db().$queryRaw<Widget[]>`
      INSERT INTO widget_probe (name) VALUES (${input.name}) RETURNING id::text AS id, name`;
    if (!widget) throw new Error('insert sem retorno');

    this.audit.describe({
      action: 'widget.create',
      resourceType: input.name === FORCE_AUDIT_FAILURE ? FORCE_AUDIT_FAILURE : 'widget',
      resourceId: widget.id,
      // O corpo inteiro vai como estado novo de propósito: a senha precisa sair ocultada.
      after: { ...widget, password: input.password, notes: input.notes },
    });

    if (input.name === EXPLODE_AFTER_INSERT) throw new Error('falha depois de gravar');
    return widget;
  }

  async rename(id: string, name: string): Promise<Widget> {
    const [before] = await this.prisma.db().$queryRaw<Widget[]>`
      SELECT id::text AS id, name FROM widget_probe WHERE id = ${id}::uuid`;
    const [after] = await this.prisma.db().$queryRaw<Widget[]>`
      UPDATE widget_probe SET name = ${name} WHERE id = ${id}::uuid RETURNING id::text AS id, name`;
    if (!after) throw new Error('widget inexistente');
    this.audit.describe({ action: 'widget.rename', resourceType: 'widget', resourceId: id, before, after });
    return after;
  }
}

@Controller('widgets-probe')
@Public()
class WidgetProbeController {
  constructor(private readonly widgets: WidgetProbeService) {}

  @Post()
  create(@Body({ schema: createWidgetSchema }) body: z.infer<typeof createWidgetSchema>): Promise<Widget> {
    return this.widgets.create(body);
  }

  @Patch(':id')
  rename(
    @Param('id', { schema: z.uuid() }) id: string,
    @Body({ schema: renameWidgetSchema }) body: z.infer<typeof renameWidgetSchema>,
  ): Promise<Widget> {
    return this.widgets.rename(id, body.name);
  }

  @Post('forbidden')
  forbidden(): never {
    throw new ForbiddenException();
  }

  @Post('no-body')
  @HttpCode(HttpStatus.NO_CONTENT)
  noBody(): void {
    return undefined;
  }

  @Get()
  list(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [WidgetProbeController], providers: [WidgetProbeService] })
export class WidgetProbeModule {}
