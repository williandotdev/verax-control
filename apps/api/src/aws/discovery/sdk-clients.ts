import { AccessAnalyzerClient } from '@aws-sdk/client-accessanalyzer';
import { CloudTrailClient } from '@aws-sdk/client-cloudtrail';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { ConfigServiceClient } from '@aws-sdk/client-config-service';
import { EC2Client } from '@aws-sdk/client-ec2';
import { ElasticLoadBalancingV2Client } from '@aws-sdk/client-elastic-load-balancing-v2';
import { GuardDutyClient } from '@aws-sdk/client-guardduty';
import { IAMClient } from '@aws-sdk/client-iam';
import { Inspector2Client } from '@aws-sdk/client-inspector2';
import { RDSClient } from '@aws-sdk/client-rds';
import { S3Client } from '@aws-sdk/client-s3';
import { SecurityHubClient } from '@aws-sdk/client-securityhub';
import { WAFV2Client } from '@aws-sdk/client-wafv2';
import { isAwsRegion } from '@verax/shared';
import { AWS_CLIENT_OPTIONS, STS_FALLBACK_REGION } from '../web-identity.js';
import type { DiscoveryClientFactory } from './clients.js';

/**
 * Os clientes de verdade da descoberta, carregados só no worker que tem a identidade do nó. As opções são as do
 * inventário: tempo curto, uma tentativa a mais e o modo adaptativo, que espaça as chamadas quando a AWS limita. O IAM
 * é global (assinado em us-east-1), e o S3 segue o redirecionamento para a região do bucket.
 */
const OPTIONS = { ...AWS_CLIENT_OPTIONS, maxAttempts: 3, retryMode: 'adaptive' } as const;

export const sdkDiscoveryClients: DiscoveryClientFactory = (credentials, homeRegion) => ({
  ec2: (region) => new EC2Client({ region, credentials, ...OPTIONS }),
  cloudtrail: (region) => new CloudTrailClient({ region, credentials, ...OPTIONS }),
  guardduty: (region) => new GuardDutyClient({ region, credentials, ...OPTIONS }),
  s3: (region) =>
    new S3Client({
      region: isAwsRegion(region) ? region : homeRegion,
      credentials,
      followRegionRedirects: true,
      ...OPTIONS,
    }),
  iam: () => new IAMClient({ region: STS_FALLBACK_REGION, credentials, ...OPTIONS }),
  logs: (region) => new CloudWatchLogsClient({ region, credentials, ...OPTIONS }),
  wafv2: (region) => new WAFV2Client({ region, credentials, ...OPTIONS }),
  securityhub: (region) => new SecurityHubClient({ region, credentials, ...OPTIONS }),
  inspector2: (region) => new Inspector2Client({ region, credentials, ...OPTIONS }),
  accessanalyzer: (region) => new AccessAnalyzerClient({ region, credentials, ...OPTIONS }),
  rds: (region) => new RDSClient({ region, credentials, ...OPTIONS }),
  elbv2: (region) => new ElasticLoadBalancingV2Client({ region, credentials, ...OPTIONS }),
  config: (region) => new ConfigServiceClient({ region, credentials, ...OPTIONS }),
});
