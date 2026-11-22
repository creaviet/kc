#!/usr/bin/env node
/**
 * Generates a CloudFormation template fragment with one API Gateway custom
 * domain, base-path mapping (/api) and optional Route53 alias per portal.
 *
 * Usage:
 *   PORTALS_FILE=ops/portals.json DOMAINS_FILE=ops/domains.json \
 *     AWS_REGION=eu-central-1 node ops/generate-api-domains.js
 *
 * domains.json shape:
 * {
 *   "vw-baev.de": {
 *     "apiHost": "api.vw-baev.de",
 *     "certificateArn": "arn:aws:acm:...",
 *     "hostedZoneId": "Z...."   // optional; omit if DNS is managed elsewhere
 *   }
 * }
 *
 * The generated file references the HTTP API id as parameter HttpApiId.
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

const DomainSchema = z.object({
  apiHost: z.string().min(3),
  certificateArn: z.string().startsWith('arn:aws:acm:'),
  hostedZoneId: z.string().startsWith('Z').optional(),
}).strict();

function sanitize(logicalName) {
  return logicalName.replace(/[^a-zA-Z0-9]/g, '');
}

function main() {
  const portals = JSON.parse(readFileSync(process.env.PORTALS_FILE ?? 'ops/portals.json', 'utf8')).portals;
  const domainsRaw = JSON.parse(readFileSync(process.env.DOMAINS_FILE ?? 'ops/domains.json', 'utf8'));
  const region = process.env.AWS_REGION;
  if (!region) throw new Error('AWS_REGION is required');

  const parsed = z.record(DomainSchema).safeParse(domainsRaw);
  if (!parsed.success) throw new Error(`domains.json invalid: ${parsed.error.message}`);

  const resources = {};
  const outputs = {};

  for (const portal of portals) {
    const domain = parsed.data[portal.portalHost];
    if (!domain) throw new Error(`no domain config for ${portal.portalHost}`);
    if (domain.apiHost !== portal.apiHost) {
      throw new Error(`apiHost mismatch for ${portal.portalHost}`);
    }

    const name = sanitize(portal.portalHost.split('.')[0]);
    const domainLogical = `ApiDomain${name}`;
    const mappingLogical = `ApiMapping${name}`;
    const recordLogical = `ApiDns${name}`;

    resources[domainLogical] = {
      Type: 'AWS::ApiGatewayV2::DomainName',
      Properties: {
        DomainName: domain.apiHost,
        DomainNameConfigurations: [{ CertificateArn: domain.certificateArn, EndpointType: 'REGIONAL' }],
      },
    };
    resources[mappingLogical] = {
      Type: 'AWS::ApiGatewayV2::ApiMapping',
      DependsOn: domainLogical,
      Properties: {
        ApiId: { Ref: 'HttpApiId' },
        DomainName: { Ref: domainLogical },
        Stage: '$default',
        BasePath: 'api',
      },
    };
    outputs[`${domainLogical}Endpoint`] = {
      Value: { 'Fn::GetAtt': [domainLogical, 'RegionalDomainName'] },
    };

    if (domain.hostedZoneId) {
      resources[recordLogical] = {
        Type: 'AWS::Route53::RecordSet',
        Properties: {
          Name: `${domain.apiHost}.`,
          Type: 'A',
          HostedZoneId: domain.hostedZoneId,
          AliasTarget: {
            DNSName: { 'Fn::GetAtt': [domainLogical, 'RegionalDomainName'] },
            HostedZoneId: { 'Fn::GetAtt': [domainLogical, 'RegionalHostedZoneId'] },
            EvaluateTargetHealth: false,
          },
        },
      };
    }
  }

  const fragment = {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: 'API Gateway custom domains for all portal identity BFFs',
    Parameters: {
      HttpApiId: { Type: 'String', Description: 'HttpApiId output of the BFF stack' },
    },
    Resources: resources,
    Outputs: outputs,
  };

  const out = process.env.OUT_FILE ?? 'ops/generated/api-domains.yaml';
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(fragment, null, 2) + '\n', { mode: 0o600 });
  console.log(`Wrote ${out} with ${Object.keys(resources).length} resources for ${portals.length} portals (region ${region}).`);
}

main();
