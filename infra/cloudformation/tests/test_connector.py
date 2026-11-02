"""Testes de segurança do template do conector (T4.3).

Leem o template com o parser do cfn-lint (mesmo venv do CI, sem dependência nova) e conferem as propriedades que o
cliente aceita ao rodar o stack: quem pode assumir o papel, que o papel só lê, e que todo destino de log é privado,
cifrado, versionado, só TLS e preservado se o stack for apagado.
"""

import pathlib
import re
import unittest

from cfnlint.decode import cfn_yaml

TEMPLATE = pathlib.Path(__file__).resolve().parents[1] / "verax-control-connector.yaml"

# Verbos de leitura aceitos nas políticas do papel. Qualquer outro verbo faz o teste falhar.
READ_ACTION = re.compile(r"^[a-z0-9-]+:(Get|List|Describe|BatchGet|Search|GET)[A-Za-z0-9*]*$")
# Ações da política extra do Prowler que ficaram de fora de propósito (README).
EXCLUDED_ACTIONS = {
    "securityhub:BatchImportFindings",
    "ecr:BatchGetImage",
    "ecr:GetDownloadUrlForLayer",
    "logs:FilterLogEvents",
}
LOGS_KEY_ARN = {"Fn::GetAtt": ["LogsKey", "Arn"]}
ACCOUNT_ID = {"Ref": "AWS::AccountId"}


def as_list(value):
    return value if isinstance(value, list) else [value]


class ConnectorTemplateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.template = cfn_yaml.load(str(TEMPLATE))
        cls.resources = cls.template["Resources"]

    def of_type(self, resource_type):
        return {name: res for name, res in self.resources.items() if res["Type"] == resource_type}

    def role(self):
        return self.resources["VeraxReadOnlyRole"]["Properties"]

    def bucket_policy_for(self, bucket):
        for res in self.of_type("AWS::S3::BucketPolicy").values():
            if res["Properties"]["Bucket"] == {"Ref": bucket}:
                return res["Properties"]["PolicyDocument"]["Statement"]
        self.fail(f"{bucket} sem bucket policy")

    # --- Papel ---

    def test_only_verax_roles_with_external_id_can_assume(self):
        statements = self.role()["AssumeRolePolicyDocument"]["Statement"]
        self.assertEqual(len(statements), 1)
        statement = statements[0]
        self.assertEqual(statement["Effect"], "Allow")
        self.assertEqual(statement["Action"], "sts:AssumeRole")
        self.assertEqual(
            statement["Principal"], {"AWS": {"Fn::Sub": "arn:${AWS::Partition}:iam::${VeraxAccountId}:root"}}
        )
        self.assertEqual(statement["Condition"]["StringEquals"], {"sts:ExternalId": {"Ref": "ExternalId"}})
        self.assertEqual(
            statement["Condition"]["ArnLike"],
            {"aws:PrincipalArn": {"Fn::Sub": "arn:${AWS::Partition}:iam::${VeraxAccountId}:role/${VeraxRolePrefix}*"}},
        )

    def test_external_id_is_hidden_and_long(self):
        parameter = self.template["Parameters"]["ExternalId"]
        self.assertTrue(parameter["NoEcho"])
        self.assertGreaterEqual(parameter["MinLength"], 32)
        self.assertNotIn("Default", parameter)

    def test_verax_account_is_a_12_digit_id(self):
        self.assertEqual(self.template["Parameters"]["VeraxAccountId"]["AllowedPattern"], "^[0-9]{12}$")

    def test_role_has_fixed_name_and_short_sessions(self):
        self.assertEqual(self.role()["RoleName"], "VeraxControlReadOnly")
        self.assertLessEqual(self.role()["MaxSessionDuration"], 3600)

    def test_managed_policies_are_read_only(self):
        self.assertEqual(
            self.role()["ManagedPolicyArns"],
            [
                {"Fn::Sub": "arn:${AWS::Partition}:iam::aws:policy/SecurityAudit"},
                {"Fn::Sub": "arn:${AWS::Partition}:iam::aws:policy/job-function/ViewOnlyAccess"},
            ],
        )

    def test_inline_policies_only_read(self):
        for policy in self.role()["Policies"]:
            for statement in policy["PolicyDocument"]["Statement"]:
                with self.subTest(policy=policy["PolicyName"], sid=statement["Sid"]):
                    self.assertEqual(statement["Effect"], "Allow")
                    for action in as_list(statement["Action"]):
                        self.assertNotIn(action, EXCLUDED_ACTIONS)
                        if action == "kms:Decrypt":
                            # Só para ler os logs pelo S3.
                            self.assertEqual(
                                statement["Condition"]["StringEquals"]["kms:ViaService"],
                                {"Fn::Sub": "s3.${AWS::Region}.amazonaws.com"},
                            )
                        else:
                            self.assertRegex(action, READ_ACTION)

    # --- Destinos de log ---

    def test_buckets_are_private_encrypted_versioned_and_retained(self):
        buckets = self.of_type("AWS::S3::Bucket")
        self.assertEqual(
            set(buckets), {"AccessLogsBucket", "CloudTrailBucket", "GuardDutyBucket", "WafLogsBucket"}
        )
        for name, bucket in buckets.items():
            with self.subTest(bucket=name):
                props = bucket["Properties"]
                self.assertEqual(bucket["DeletionPolicy"], "Retain")
                self.assertEqual(bucket["UpdateReplacePolicy"], "Retain")
                self.assertEqual(
                    props["PublicAccessBlockConfiguration"],
                    {
                        "BlockPublicAcls": True,
                        "BlockPublicPolicy": True,
                        "IgnorePublicAcls": True,
                        "RestrictPublicBuckets": True,
                    },
                )
                self.assertEqual(props["OwnershipControls"]["Rules"], [{"ObjectOwnership": "BucketOwnerEnforced"}])
                self.assertEqual(props["VersioningConfiguration"], {"Status": "Enabled"})
                rule = props["LifecycleConfiguration"]["Rules"][0]
                self.assertEqual(rule["ExpirationInDays"], {"Ref": "LogRetentionDays"})
                encryption = props["BucketEncryption"]["ServerSideEncryptionConfiguration"][0]
                if name == "AccessLogsBucket":
                    # O log de acesso do S3 só é entregue com SSE-S3.
                    self.assertEqual(encryption["ServerSideEncryptionByDefault"], {"SSEAlgorithm": "AES256"})
                else:
                    self.assertEqual(
                        encryption["ServerSideEncryptionByDefault"],
                        {"SSEAlgorithm": "aws:kms", "KMSMasterKeyID": LOGS_KEY_ARN},
                    )
                    self.assertEqual(props["LoggingConfiguration"]["DestinationBucketName"], {"Ref": "AccessLogsBucket"})

    def test_buckets_deny_plain_http(self):
        for name in self.of_type("AWS::S3::Bucket"):
            with self.subTest(bucket=name):
                denies = [
                    s
                    for s in self.bucket_policy_for(name)
                    if s["Effect"] == "Deny"
                    and s["Principal"] == "*"
                    and s.get("Condition", {}).get("Bool") == {"aws:SecureTransport": "false"}
                ]
                self.assertEqual(len(denies), 1)

    def test_service_writes_are_limited_to_this_account(self):
        policies = {name: self.bucket_policy_for(name) for name in self.of_type("AWS::S3::Bucket")}
        policies["LogsKey"] = self.resources["LogsKey"]["Properties"]["KeyPolicy"]["Statement"]
        for owner, statements in policies.items():
            for statement in statements:
                principal = statement.get("Principal")
                if statement["Effect"] != "Allow" or not isinstance(principal, dict) or "Service" not in principal:
                    continue
                with self.subTest(owner=owner, sid=statement["Sid"]):
                    conditions = statement["Condition"]
                    source_account = conditions.get("StringEquals", {}).get("aws:SourceAccount")
                    source_arn = conditions.get("StringEquals", {}).get("aws:SourceArn") or conditions.get(
                        "ArnLike", {}
                    ).get("aws:SourceArn")
                    scoped_by_arn = any(
                        "${AWS::AccountId}" in arn.get("Fn::Sub", "") for arn in as_list(source_arn or [])
                    )
                    self.assertTrue(source_account == ACCOUNT_ID or scoped_by_arn)

    def test_key_rotates_and_is_retained(self):
        key = self.resources["LogsKey"]
        self.assertTrue(key["Properties"]["EnableKeyRotation"])
        self.assertEqual(key["DeletionPolicy"], "Retain")

    def test_trail_is_multi_region_validated_and_encrypted(self):
        trail = self.resources["Trail"]["Properties"]
        self.assertTrue(trail["IsMultiRegionTrail"])
        self.assertTrue(trail["IncludeGlobalServiceEvents"])
        self.assertTrue(trail["EnableLogFileValidation"])
        self.assertTrue(trail["IsLogging"])
        self.assertEqual(trail["KMSKeyId"], LOGS_KEY_ARN)
        # O nome usado no aws:SourceArn da bucket policy precisa ser o da trilha.
        for statement in self.bucket_policy_for("CloudTrailBucket"):
            if statement.get("Principal") == {"Service": "cloudtrail.amazonaws.com"}:
                arn = statement["Condition"]["StringEquals"]["aws:SourceArn"]["Fn::Sub"]
                self.assertTrue(arn.endswith(f":trail/{trail['TrailName']}"))

    def test_guardduty_exports_only_with_the_connector_key(self):
        export = self.resources["GuardDutyExport"]["Properties"]
        self.assertEqual(export["DestinationType"], "S3")
        self.assertEqual(export["DestinationProperties"]["KmsKeyArn"], LOGS_KEY_ARN)
        denies = [
            s
            for s in self.bucket_policy_for("GuardDutyBucket")
            if s["Effect"] == "Deny" and s.get("Principal") == {"Service": "guardduty.amazonaws.com"}
        ]
        self.assertEqual(
            denies[0]["Condition"]["StringNotEquals"],
            {"s3:x-amz-server-side-encryption-aws-kms-key-id": LOGS_KEY_ARN},
        )

    def test_waf_bucket_uses_the_required_prefix(self):
        name = self.resources["WafLogsBucket"]["Properties"]["BucketName"]["Fn::Sub"]
        self.assertTrue(name.startswith("aws-waf-logs-"))


if __name__ == "__main__":
    unittest.main()
