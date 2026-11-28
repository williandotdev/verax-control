import { type AwsSource, bucketNameProblem, type CloudAccount } from '@verax/shared';
import { useState } from 'react';
import { Field } from '@/components/ui/field';
import { awsSourceName } from '@/features/admin/aws-onboarding-labels';
import { ConsoleTerm, Notice } from '@/features/admin/aws-ui';
import { CommandBlock } from '@/features/admin/command-block';
import {
  albBucketPolicy,
  albTarget,
  createBucketCommand,
  enableAccessLogsCommand,
  loadBalancerType,
  putBucketPolicyCommand,
  suggestedLogBucket,
} from './alb-logging';

/**
 * Como ligar o log de acesso de um ALB, para o cliente fazer na conta dele: o bucket na mesma região, só com SSE-S3, a política
 * que deixa a AWS entregar os logs, sem prefixo, e os atributos do balanceador. Daqui o Verax só mostra os passos: o botão
 * "Ligar logs" (`alb-logging-control.tsx`) é o outro caminho, e com ele estes passos ficam como alternativa (`manual`).
 */
export function AlbLoggingSteps({
  source,
  account,
  manual = false,
}: {
  source: AwsSource;
  account: CloudAccount;
  /** Ao lado do botão "Ligar logs": a alternativa de quem prefere fazer na própria conta. */
  manual?: boolean;
}) {
  const target = albTarget(source, account.accountId);
  const [bucket, setBucket] = useState(() => suggestedLogBucket(account.accountId, source.region));
  const name = awsSourceName(source);
  const problem = bucketNameProblem(bucket);
  const policy = target === null ? null : albBucketPolicy(target, bucket);
  const create = target === null ? null : createBucketCommand(target, bucket);
  const put = target === null ? null : putBucketPolicyCommand(target, bucket);
  const enable = target === null ? null : enableAccessLogsCommand(target, bucket);

  return (
    <details className="rounded-md border text-sm">
      <summary className="cursor-pointer px-3 py-2 font-medium wrap-anywhere">
        {manual
          ? 'Prefere fazer você mesmo? Os passos na sua conta AWS'
          : `Como ligar o log de acesso do ${name}`}
      </summary>
      <div className="space-y-4 border-t p-3">
        <p>
          {manual
            ? 'Se você não quer dar ao Verax a permissão de ligar o log, faça você mesmo, na sua conta AWS, com um bucket seu.'
            : 'Estes passos são seus, na sua conta AWS: o Verax só lê, e nunca liga nem altera nada.'}{' '}
          Depois deles, clique em Descobrir de novo, em &ldquo;O que encontramos&rdquo;.
        </p>
        <Notice tone="medium" title="Tem custo na AWS.">
          <p>
            A AWS cobra o S3 pelo que é gravado e guardado, e pela transferência dos arquivos que o Verax lê.
            Quanto mais visitas, maior a conta. Defina também a retenção do bucket: recomendamos ao menos 180
            dias.
          </p>
        </Notice>
        <Field
          label="Nome do bucket do log"
          hint="Um bucket novo, ou um que já exista na mesma região. O nome entra nos comandos abaixo."
          error={problem ?? undefined}
          value={bucket}
          onChange={(event) => setBucket(event.target.value.trim())}
          autoComplete="off"
          spellCheck={false}
          className="max-w-md"
        />

        <section className="space-y-2">
          <h5 className="font-semibold">Pelo console</h5>
          <ol className="list-decimal space-y-2 pl-5">
            <li>
              No S3, crie o bucket <strong className="wrap-anywhere">na região {source.region}</strong>, a
              mesma do balanceador. Em <ConsoleTerm pt="Criptografia padrão" en="Default encryption" />, deixe{' '}
              <strong>SSE-S3</strong>: com uma chave do KMS, a AWS não entrega o log.
            </li>
            <li>
              Na aba <ConsoleTerm pt="Permissões" en="Permissions" /> do bucket, em{' '}
              <ConsoleTerm pt="Política do bucket" en="Bucket policy" />, cole a política abaixo. Se o bucket
              já tem uma política, acrescente só a declaração.
            </li>
            <li>
              No EC2, em <ConsoleTerm pt="Balanceadores de carga" en="Load balancers" />, abra o{' '}
              <span className="font-mono text-xs wrap-anywhere">{name}</span>, aba{' '}
              <ConsoleTerm pt="Atributos" en="Attributes" />, e edite. Ligue{' '}
              <ConsoleTerm pt="Logs de acesso" en="Access logs" /> e informe o endereço{' '}
              <code className="font-mono text-xs wrap-anywhere">
                s3://{problem === null ? bucket : 'NOME_DO_BUCKET'}
              </code>
              , <strong>sem prefixo</strong>: com um prefixo, os arquivos ficam fora do que o Verax lê.
            </li>
          </ol>
          {policy === null ? (
            <p className="text-critical-text">
              {target === null
                ? 'A descoberta não trouxe o ARN deste balanceador: rode a descoberta de novo para a política e os comandos aparecerem prontos.'
                : 'Corrija o nome do bucket para a política e os comandos aparecerem prontos.'}
            </p>
          ) : (
            <CommandBlock command={policy} label={`Copiar a política do bucket para o ${name}`} />
          )}
        </section>

        <p>
          Se um dia for apagar esse bucket, <strong>desligue antes o log de acesso</strong> do balanceador:
          senão, a AWS pode passar a gravar o log num bucket de mesmo nome que outra pessoa criar.
        </p>

        {create !== null && put !== null && enable !== null && (
          <section className="space-y-2">
            <h5 className="font-semibold">Pela linha de comando (no AWS CloudShell, por exemplo)</h5>
            <p>1. Crie o bucket, se ele ainda não existe. Ele já nasce com SSE-S3 e fechado ao público.</p>
            <CommandBlock command={create} label={`Copiar o comando que cria o bucket para o ${name}`} />
            <p>
              2. Grave a política. <strong>Num bucket que já tem política, não rode este comando</strong>: ele
              troca a política inteira. Nesse caso, acrescente a declaração pelo console.
            </p>
            <CommandBlock command={put} label={`Copiar o comando da política do bucket para o ${name}`} />
            <p>3. Ligue o log de acesso do balanceador, sem prefixo.</p>
            <CommandBlock command={enable} label={`Copiar o comando que liga o log do ${name}`} />
          </section>
        )}
      </div>
    </details>
  );
}

/** Por que um balanceador que não é ALB não serve: o NLB e o GWLB, cada um com o motivo dele. */
export function UnsupportedBalancerReason({ source }: { source: AwsSource }) {
  const type = loadBalancerType(source.details.arn);
  return (
    <p className="text-xs text-muted-foreground">
      {type === 'net'
        ? 'É um NLB (balanceador de rede): o log dele só existe nas conexões TLS e não traz a URL de cada requisição. Não há o que fazer aqui; se houver um ALB atrás dele, é o log do ALB que serve.'
        : type === 'gwy'
          ? 'É um GWLB (balanceador de gateway): ele não grava log de acesso.'
          : 'O Verax só lê o log dos balanceadores de aplicação (ALB).'}
    </p>
  );
}

/**
 * O log do ALB gravado atrás de um prefixo, que o papel só lista a partir do modelo 3 da pilha. O caminho é atualizar a
 * pilha: o balanceador e o bucket do cliente ficam como estão.
 */
export function AlbPrefixFix({ source, again }: { source: AwsSource; again: string }) {
  const { customPrefix } = source.details;
  return (
    <p>
      O log deste balanceador é gravado atrás de um prefixo antes de{' '}
      <code className="font-mono">AWSLogs/</code>
      {customPrefix !== undefined && (
        <>
          {' '}
          (<code className="break-all font-mono">{customPrefix}</code>)
        </>
      )}
      , e a pilha da Verax na sua conta ainda não lista essa pasta.{' '}
      <a href="#aws-pilha" className="underline">
        Atualize a pilha
      </a>{' '}
      com o arquivo desta tela e clique em {again}. Nada muda no balanceador nem no bucket: o log continua
      onde está.
    </p>
  );
}
