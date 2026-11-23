import {
  AWS_SOURCE_GLOBAL_REGION,
  AWS_SOURCE_KIND_INFO,
  AWS_SOURCE_PERMISSION_CODES,
  type AwsOnboarding,
  type AwsSource,
  type AwsSourceNote,
  type AwsSourcePermissionCode,
  type CloudAccount,
} from '@verax/shared';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  awsKmsKeyPolicyStatement,
  awsLogGroupTagCommand,
  awsReaderPrincipalArn,
  logGroupArnOf,
  logGroupResourceArn,
} from '@/features/admin/aws-connect';
import type { SourceRetry } from '@/features/admin/aws-hooks';
import {
  AWS_AUTHORIZATION_TEXTS,
  AWS_SOURCE_KIND_TEXTS,
  AWS_SOURCE_LOGGING_STATE_LABELS,
  AWS_SOURCE_NOTE_TEXTS,
  awsOnboardingErrorText,
  awsPermissionDetailText,
  awsSourceName,
} from '@/features/admin/aws-onboarding-labels';
import { Tag } from '@/features/admin/aws-ui';
import { CommandBlock } from '@/features/admin/command-block';

/** A região de uma fonte na tela: a da AWS, ou "conta inteira" (o serviço desligado em toda a conta, o bucket). */
export function SourceRegion({ region }: { region: string }) {
  return <>{region === AWS_SOURCE_GLOBAL_REGION ? 'conta inteira' : region}</>;
}

/**
 * O que identifica uma fonte numa linha: o tipo, o nome (o da trilha, da Web ACL, do grupo), a região e, quando o
 * serviço diz, se está gravando. As marcas (recomendada, coberta pela API, sensível) vêm de quem monta a lista.
 */
export function SourceTitle({ source, tags }: { source: AwsSource; tags?: ReactNode }) {
  const name = awsSourceName(source);
  return (
    <span className="min-w-0">
      <span className="font-medium">{AWS_SOURCE_KIND_TEXTS[source.kind].label}</span>
      {name !== '' && (
        <>
          {' · '}
          <span className="font-mono text-xs wrap-anywhere">{name}</span>
        </>
      )}
      <span className="text-muted-foreground">
        {' · '}
        <SourceRegion region={source.region} />
        {source.loggingState !== null && <>, {AWS_SOURCE_LOGGING_STATE_LABELS[source.loggingState]}</>}
      </span>
      {tags && <span className="ml-1.5 inline-flex flex-wrap gap-1 align-middle">{tags}</span>}
    </span>
  );
}

/** De onde a fonte é lida, quando é um bucket: o nome dele e a pasta. */
export function SourceLocation({ source }: { source: AwsSource }) {
  const { bucket, prefix } = source.details;
  if (bucket === undefined) return null;
  return (
    <p className="text-xs text-muted-foreground wrap-anywhere">
      Bucket <code className="font-mono">{bucket}</code>
      {prefix !== undefined && (
        <>
          , pasta <code className="font-mono">{prefix}</code>
        </>
      )}
    </p>
  );
}

/** As notas da fonte que são texto corrido (as marcas "recomendada" e "coberta pela API" ficam ao lado do nome). */
export function SourceNotes({ source, omit = [] }: { source: AwsSource; omit?: readonly AwsSourceNote[] }) {
  const notes = source.notes.filter((note) => note !== 'recommended' && !omit.includes(note));
  if (notes.length === 0) return null;
  return (
    <ul className="space-y-0.5 text-xs text-muted-foreground">
      {notes.map((note) => (
        <li key={note}>{AWS_SOURCE_NOTE_TEXTS[note]}</li>
      ))}
    </ul>
  );
}

/** A marca de uma fonte que pode trazer dado de aplicação. */
export function SensitiveTag() {
  return <Tag>Sensível</Tag>;
}

function isPermissionCode(detail: string): detail is AwsSourcePermissionCode {
  return (AWS_SOURCE_PERMISSION_CODES as readonly string[]).includes(detail);
}

/** O ARN do grupo de logs para o comando da etiqueta: o da descoberta ou, sem ele, o montado pelo nome; null fora do formato. */
function tagCommandArn(source: AwsSource, accountId: string): string | null {
  return (
    logGroupResourceArn(source.details.arn) ??
    logGroupArnOf(accountId, source.region, source.details.logGroup ?? source.name)
  );
}

/**
 * O que fazer para o Verax poder ler uma fonte, pelo motivo exato da última conferência (`permissionDetail`): ligar a
 * autorização na pilha, pôr a etiqueta no grupo (com o comando pronto), incluir uma declaração na política da chave
 * KMS, cadastrar o bucket nos buckets fora do padrão, e assim por diante. Sempre com o "Verificar de novo" da fonte.
 */
export function PermissionFix({
  source,
  account,
  onboarding,
  retry,
  again = 'Verificar de novo',
}: {
  source: AwsSource;
  account: CloudAccount;
  onboarding: AwsOnboarding;
  /** O "Verificar de novo" da fonte; ausente para quem só lê. */
  retry?: ReactNode;
  /** O nome do botão que pede a leitura da fonte de novo, como a lista o mostra (o texto da correção o cita). */
  again?: string;
}) {
  const detail = source.permissionDetail;
  const keyMode = onboarding.credentialMode === 'access_key';
  const bucket = source.details.bucket;
  /** "O bucket nome" (ou só "O bucket", quando a descoberta não o trouxe), com a inicial pedida. */
  const bucketName = (initial: 'O' | 'o') => (
    <>
      {initial} bucket
      {bucket !== undefined && (
        <>
          {' '}
          <code className="break-all font-mono">{bucket}</code>
        </>
      )}
    </>
  );
  let fix: ReactNode;
  if (detail === null) {
    fix = (
      <p>
        A permissão desta fonte ainda não foi conferida. Clique em {again}: o Verax lê a fonte na AWS na hora.
      </p>
    );
  } else if (!isPermissionCode(detail)) {
    fix = (
      <p>
        A AWS negou a ação <code className="font-mono">{detail}</code>. Atualize a{' '}
        {keyMode ? 'política do usuário de leitura' : 'pilha'} para o modelo atual, em{' '}
        <a href="#aws-pilha" className="underline">
          {keyMode ? 'Usuário de leitura na AWS' : 'Pilha na AWS'}
        </a>
        ; se já está atual, uma política da organização (SCP) pode estar negando essa ação. Depois de
        corrigir, clique em {again}.
      </p>
    );
  } else if (detail === 'capability_off') {
    const capability = AWS_SOURCE_KIND_INFO[source.kind].capability;
    const label = capability === 'discovery' ? 'a descoberta' : AWS_AUTHORIZATION_TEXTS[capability].label;
    fix = (
      <p>
        A autorização &ldquo;{label}&rdquo; está desligada{' '}
        {keyMode ? 'nas políticas do usuário de leitura' : 'na pilha'}. Para o Verax ler esta fonte, ligue-a
        em{' '}
        <a href="#aws-pilha" className="underline">
          {keyMode ? 'Atualize as políticas do usuário de leitura' : 'Atualize a pilha'}
        </a>
        . Depois de atualizar, clique em {again}: o Verax lê de novo o que foi autorizado, na hora.
      </p>
    );
  } else if (detail === 'tag_missing') {
    fix = (
      <>
        <p>
          O Verax só lê um grupo de logs que tenha a etiqueta{' '}
          <code className="font-mono">verax-control = leitura</code>. Para liberar este grupo, rode no
          terminal ou no AWS CloudShell:
        </p>
        <CommandBlock
          command={awsLogGroupTagCommand(tagCommandArn(source, account.accountId))}
          label={`Copiar o comando da etiqueta do grupo ${source.name}`}
        />
        <p>Depois, clique em {again}: o Verax lê a etiqueta do grupo na hora.</p>
      </>
    );
  } else if (detail === 'kms_denied') {
    fix = (
      <>
        <p>
          {bucketName('O')} é cifrado com uma chave KMS que não decifra para o Verax
          {source.details.kmsKeyArn !== undefined && (
            <>
              {' '}
              (<code className="break-all font-mono">{source.details.kmsKeyArn}</code>)
            </>
          )}
          . No console do KMS, abra a chave e inclua esta declaração na política dela:
        </p>
        <CommandBlock
          command={awsKmsKeyPolicyStatement(
            awsReaderPrincipalArn(account.accountId, onboarding.credentialMode),
          )}
          label="Copiar a declaração para a política da chave KMS"
        />
        <p>
          Ela só deixa decifrar os arquivos que o Verax já pode ler, e só pelo S3. Depois, clique em {again}.
        </p>
      </>
    );
  } else if (detail === 'outside_awslogs_prefix') {
    fix = (
      <p>
        Os arquivos desta fonte ficam atrás de um prefixo antes de <code className="font-mono">AWSLogs/</code>
        {source.details.customPrefix !== undefined && (
          <>
            {' '}
            (<code className="break-all font-mono">{source.details.customPrefix}</code>)
          </>
        )}
        , fora do que o Verax lê sozinho. Cadastre {bucketName('o')} em{' '}
        <a href="#aws-buckets" className="underline">
          Avançado: buckets fora do padrão
        </a>{' '}
        e atualize a pilha.
      </p>
    );
  } else if (detail === 'bucket_denied') {
    fix = (
      <p>
        {bucketName('O')} não deixa o Verax listar nem ler os arquivos. Num bucket de outra conta (o bucket
        central da organização), a política do bucket precisa citar{' '}
        <code className="break-all font-mono">
          {awsReaderPrincipalArn(account.accountId, onboarding.credentialMode)}
        </code>
        . Depois, clique em {again}.
      </p>
    );
  } else if (detail === 'bucket_missing') {
    fix = (
      <p>
        {bucketName('O')} não existe mais. Confira na AWS para onde este log é gravado e, depois de corrigir o
        destino, clique em {again}.
      </p>
    );
  } else {
    fix = <p>A AWS não respondeu à conferência da permissão. Clique em {again}.</p>;
  }
  return (
    <div className="space-y-1.5 text-xs">
      <p className="font-medium">Falta permissão: {awsPermissionDetailText(detail)}.</p>
      {fix}
      {retry}
    </div>
  );
}

/**
 * O botão "Verificar de novo" de uma fonte: pede à API que leia a fonte de novo na AWS, agora (a etiqueta posta no
 * grupo, a autorização ligada na pilha, o destino corrigido). Com o pedido ainda sem resposta, diz que está
 * conferindo; depois, fica desligado pelos segundos que faltam do intervalo de 30 s por fonte, com a contagem no rótulo.
 */
export function RetryButton({
  source,
  retry,
  label = 'Verificar de novo',
}: {
  source: AwsSource;
  retry: SourceRetry;
  label?: string;
}) {
  // O pedido gravado e ainda não respondido pelo servidor: repetir não muda nada.
  const requested = source.probeRequestedAt !== null;
  const seconds = retry.secondsLeft(source.id);
  const text = requested ? 'Conferindo…' : seconds > 0 ? `${label} em ${seconds} s` : label;
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      disabled={retry.pendingId === source.id || requested || seconds > 0}
      onClick={() => retry.retry(source.id)}
      aria-label={`${text}: ${AWS_SOURCE_KIND_TEXTS[source.kind].label} ${awsSourceName(source)}`.trim()}
    >
      {text}
    </Button>
  );
}

/** A recusa do último "Verificar de novo", quando é de uma das fontes desta lista. */
export function RetryError({ retry, sources }: { retry: SourceRetry; sources: readonly AwsSource[] }) {
  const failed = retry.error;
  if (failed === null || !sources.some((source) => source.id === failed.sourceId)) return null;
  return (
    <p role="alert" className="text-sm text-critical-text">
      {awsOnboardingErrorText(failed.error)}
    </p>
  );
}
