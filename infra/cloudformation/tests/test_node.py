"""Testes de segurança do template do nó.

Leem o template com o parser do cfn-lint (mesmo venv do CI) e conferem o que a conta que hospeda o nó aceita: só
recursos novos, nenhuma porta de entrada, VM sem SSH e com IMDSv2, discos cifrados e preservados, papel que só lê os
clientes pelo conector e nunca altera a conta, e instalação que só executa o pacote depois de conferir o SHA-256.
"""

import fnmatch
import pathlib
import re
import unittest

from cfnlint.decode import cfn_yaml

TEMPLATE = pathlib.Path(__file__).resolve().parents[1] / "verax-control-node.yaml"
NODE_ID = {"Fn::If": ["HasName", {"Fn::Sub": "verax-control-node-${NodeName}"}, "verax-control-node"]}
CONNECTOR_ROLE = {"Fn::Sub": "arn:${AWS::Partition}:iam::*:role/VeraxControlReadOnly"}
# Ações da AmazonSSMManagedInstanceCore (versão v2, a padrão). Nenhuma pode ser cortada pela negação explícita.
SSM_CORE_ACTIONS = {
    "ssm:DescribeAssociation",
    "ssm:GetDeployablePatchSnapshotForInstance",
    "ssm:GetDocument",
    "ssm:DescribeDocument",
    "ssm:GetManifest",
    "ssm:ListAssociations",
    "ssm:ListInstanceAssociations",
    "ssm:PutInventory",
    "ssm:PutComplianceItems",
    "ssm:PutConfigurePackageResult",
    "ssm:UpdateAssociationStatus",
    "ssm:UpdateInstanceAssociationStatus",
    "ssm:UpdateInstanceInformation",
    "ssmmessages:CreateControlChannel",
    "ssmmessages:CreateDataChannel",
    "ssmmessages:OpenControlChannel",
    "ssmmessages:OpenDataChannel",
    "ec2messages:AcknowledgeMessage",
    "ec2messages:DeleteMessage",
    "ec2messages:FailMessage",
    "ec2messages:GetEndpoint",
    "ec2messages:GetMessages",
    "ec2messages:SendReply",
}
# O que um nó comprometido não pode fazer na conta que o hospeda.
MUST_DENY = {
    "iam:CreateUser",
    "iam:AttachRolePolicy",
    "iam:PassRole",
    "organizations:LeaveOrganization",
    "ec2:RunInstances",
    "ec2:TerminateInstances",
    "ec2:AuthorizeSecurityGroupIngress",
    "ec2:ModifyInstanceAttribute",
    "ec2:DeleteSnapshot",
    "ec2:CreateSnapshot",
    "lambda:CreateFunction",
    "cloudformation:DeleteStack",
    "cloudtrail:StopLogging",
    "cloudtrail:DeleteTrail",
    "logs:DeleteLogGroup",
    "logs:PutRetentionPolicy",
    "logs:PutSubscriptionFilter",
    "wafv2:PutLoggingConfiguration",
    "guardduty:DeleteDetector",
    "securityhub:BatchUpdateFindings",
    "kms:ScheduleKeyDeletion",
    "ssm:SendCommand",
    "ssm:StartSession",
    "ssm:PutParameter",
}


def as_list(value):
    return value if isinstance(value, list) else [value]


def matches(action, patterns):
    return any(fnmatch.fnmatchcase(action.lower(), pattern.lower()) for pattern in patterns)


class NodeTemplateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.template = cfn_yaml.load(str(TEMPLATE))
        cls.resources = cls.template["Resources"]
        cls.parameters = cls.template["Parameters"]

    def of_type(self, resource_type):
        return {name: res for name, res in self.resources.items() if res["Type"] == resource_type}

    def role(self):
        return self.resources["NodeRole"]["Properties"]

    def statements(self, effect):
        return [
            s
            for policy in self.role()["Policies"]
            for s in policy["PolicyDocument"]["Statement"]
            if s["Effect"] == effect
        ]

    def launch_data(self):
        return self.resources["LaunchTemplate"]["Properties"]["LaunchTemplateData"]

    def apply_commands(self):
        return self.resources["ApplyDocument"]["Properties"]["Content"]["mainSteps"][0]["inputs"]["runCommand"]

    # --- Só recursos novos ---

    def test_only_creates_new_resources(self):
        # Nenhum recurso que referencie algo existente da conta (VPC, sub-rede, papel ou bucket informados).
        for name, parameter in self.parameters.items():
            with self.subTest(parameter=name):
                self.assertNotRegex(parameter["Type"], r"AWS::EC2::(VPC|Subnet|SecurityGroup)::Id")
        self.assertEqual(self.resources["Vpc"]["Properties"]["CidrBlock"], "10.250.0.0/24")
        self.assertIs(self.resources["Subnet"]["Properties"]["MapPublicIpOnLaunch"], False)

    def test_everything_carries_the_node_tag(self):
        taggable = [
            "Vpc",
            "InternetGateway",
            "Subnet",
            "RouteTable",
            "NodeSecurityGroup",
            "FlowLog",
            "BackupBucket",
            "NodeRole",
            "DataVolume",
            "AlertTopic",
        ]
        for name in taggable:
            with self.subTest(resource=name):
                tags = {t["Key"]: t["Value"] for t in self.resources[name]["Properties"]["Tags"]}
                self.assertEqual(tags["verax-control-node"], NODE_ID)
        for spec in self.launch_data()["TagSpecifications"]:
            with self.subTest(spec=spec["ResourceType"]):
                tags = {t["Key"]: t["Value"] for t in spec["Tags"]}
                self.assertEqual(tags["verax-control-node"], NODE_ID)

    # --- Rede ---

    def test_no_inbound_and_minimal_outbound(self):
        group = self.resources["NodeSecurityGroup"]["Properties"]
        self.assertNotIn("SecurityGroupIngress", group)
        self.assertFalse(self.of_type("AWS::EC2::SecurityGroupIngress"))
        egress = {(r["IpProtocol"], r["FromPort"], r["ToPort"]) for r in group["SecurityGroupEgress"]}
        self.assertEqual(egress, {("tcp", 443, 443), ("tcp", 7844, 7844), ("udp", 7844, 7844)})

    def test_vpc_traffic_is_recorded(self):
        flow = self.resources["FlowLog"]["Properties"]
        self.assertEqual(flow["TrafficType"], "ALL")
        self.assertEqual(flow["ResourceId"], {"Ref": "Vpc"})

    # --- VM ---

    def test_vm_requires_imdsv2_and_has_no_ssh_key(self):
        data = self.launch_data()
        self.assertEqual(data["MetadataOptions"]["HttpTokens"], "required")
        # 2: o manager do Wazuh roda num contêiner; o host bloqueia o IMDS para os demais (pacote do nó).
        self.assertEqual(data["MetadataOptions"]["HttpPutResponseHopLimit"], 2)
        self.assertNotIn("KeyName", data)
        self.assertNotIn("UserData", data)
        self.assertTrue(data["DisableApiTermination"])

    def test_disks_are_encrypted_and_data_survives(self):
        for mapping in self.launch_data()["BlockDeviceMappings"]:
            self.assertTrue(mapping["Ebs"]["Encrypted"])
        volume = self.resources["DataVolume"]
        self.assertTrue(volume["Properties"]["Encrypted"])
        self.assertEqual(volume["DeletionPolicy"], "Snapshot")
        self.assertEqual(volume["UpdateReplacePolicy"], "Snapshot")

    def test_daily_snapshots_target_the_data_volume(self):
        details = self.resources["DailySnapshots"]["Properties"]["PolicyDetails"]
        volume_tags = {t["Key"]: t["Value"] for t in self.resources["DataVolume"]["Properties"]["Tags"]}
        for tag in details["TargetTags"]:
            self.assertEqual(volume_tags[tag["Key"]], tag["Value"])
        self.assertGreaterEqual(details["Schedules"][0]["RetainRule"]["Count"], 7)

    # --- Bucket ---

    def test_bucket_is_private_encrypted_versioned_retained_and_tls_only(self):
        bucket = self.resources["BackupBucket"]
        props = bucket["Properties"]
        self.assertEqual(bucket["DeletionPolicy"], "Retain")
        self.assertTrue(all(props["PublicAccessBlockConfiguration"].values()))
        self.assertEqual(len(props["PublicAccessBlockConfiguration"]), 4)
        self.assertEqual(props["OwnershipControls"]["Rules"], [{"ObjectOwnership": "BucketOwnerEnforced"}])
        self.assertEqual(props["VersioningConfiguration"], {"Status": "Enabled"})
        self.assertIn("SSEAlgorithm", props["BucketEncryption"]["ServerSideEncryptionConfiguration"][0]["ServerSideEncryptionByDefault"])
        statements = self.resources["BackupBucketPolicy"]["Properties"]["PolicyDocument"]["Statement"]
        tls = [s for s in statements if s["Effect"] == "Deny" and s["Condition"] == {"Bool": {"aws:SecureTransport": "false"}}]
        self.assertEqual(len(tls), 1)
        for statement in statements:
            if statement["Effect"] == "Allow":
                with self.subTest(sid=statement["Sid"]):
                    self.assertEqual(statement["Principal"], {"Service": "delivery.logs.amazonaws.com"})
                    self.assertEqual(
                        statement["Condition"]["StringEquals"]["aws:SourceAccount"], {"Ref": "AWS::AccountId"}
                    )

    # --- Papel ---

    def test_only_ec2_of_this_account_assumes_the_role(self):
        trust = self.role()["AssumeRolePolicyDocument"]["Statement"]
        self.assertEqual(len(trust), 1)
        self.assertEqual(trust[0]["Principal"], {"Service": "ec2.amazonaws.com"})
        self.assertEqual(trust[0]["Condition"]["StringEquals"]["aws:SourceAccount"], {"Ref": "AWS::AccountId"})
        self.assertEqual(self.role()["RoleName"], NODE_ID)
        self.assertEqual(
            self.role()["ManagedPolicyArns"],
            [{"Fn::Sub": "arn:${AWS::Partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"}],
        )

    def test_role_name_matches_the_connector_parameter(self):
        # O conector aceita ^verax-control-node[A-Za-z0-9+=,.@_-]{0,46}$; o sufixo daqui cabe nele.
        connector = cfn_yaml.load(str(TEMPLATE.parent / "verax-control-connector.yaml"))
        accepted = re.compile(connector["Parameters"]["NodeRoleName"]["AllowedPattern"])
        suffix = re.compile(self.parameters["NodeName"]["AllowedPattern"])
        for name in ["", "cliente", "a1", "cliente-com-nome-longo-26"]:
            with self.subTest(name=name):
                self.assertTrue(suffix.fullmatch(name))
                self.assertTrue(accepted.fullmatch(f"verax-control-node-{name}" if name else "verax-control-node"))

    def test_role_reads_clients_only_through_the_connector(self):
        allowed = {action: s for s in self.statements("Allow") for action in as_list(s["Action"])}
        self.assertEqual(
            set(allowed),
            {
                "sts:AssumeRole",
                "s3:ListBucket",
                "s3:GetObject",
                "s3:PutObject",
                "s3:DeleteObject",
                "ssm:GetParameter",
                "cloudwatch:PutMetricData",
            },
        )
        self.assertEqual(allowed["sts:AssumeRole"]["Resource"], CONNECTOR_ROLE)
        for action in ("s3:GetObject", "s3:PutObject", "s3:DeleteObject"):
            for resource in as_list(allowed[action]["Resource"]):
                self.assertTrue(resource["Fn::Sub"].startswith("${BackupBucket.Arn}/"), resource)
        self.assertEqual(allowed["s3:ListBucket"]["Resource"], {"Fn::GetAtt": ["BackupBucket", "Arn"]})
        self.assertEqual(
            allowed["cloudwatch:PutMetricData"]["Condition"],
            {"StringEquals": {"cloudwatch:namespace": "VeraxControl/Node"}},
        )

    def test_explicit_denies(self):
        denies = self.statements("Deny")
        everywhere = {a for s in denies if s.get("Resource") == "*" for a in as_list(s["Action"])}
        missing = {action for action in MUST_DENY if not matches(action, everywhere)}
        self.assertFalse(missing, f"sem negação explícita: {sorted(missing)}")
        by_sid = {s["Sid"]: s for s in denies}
        self.assertEqual(by_sid["SoOPapelDosConectores"]["NotResource"], CONNECTOR_ROLE)
        self.assertIn("sts:AssumeRole", by_sid["SoOPapelDosConectores"]["Action"])
        self.assertEqual(
            by_sid["SoEscreverNoBucketDoNo"]["NotResource"],
            [{"Fn::GetAtt": ["BackupBucket", "Arn"]}, {"Fn::Sub": "${BackupBucket.Arn}/*"}],
        )
        self.assertTrue(matches("s3:PutObject", by_sid["SoEscreverNoBucketDoNo"]["Action"]))
        self.assertTrue(matches("s3:DeleteObject", by_sid["SoEscreverNoBucketDoNo"]["Action"]))
        parameters = by_sid["SoOsParametrosDoNo"]
        self.assertEqual(
            set(parameters["Action"]),
            {"ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath", "ssm:GetParameterHistory"},
        )
        self.assertTrue(parameters["NotResource"]["Fn::Sub"][0].endswith(":parameter/${Id}/*"))

    def test_deny_does_not_cut_what_the_node_needs(self):
        everywhere = {a for s in self.statements("Deny") if s.get("Resource") == "*" for a in as_list(s["Action"])}
        needed = SSM_CORE_ACTIONS | {a for s in self.statements("Allow") for a in as_list(s["Action"])}
        clashes = {action for action in needed if matches(action, everywhere)}
        self.assertFalse(clashes, f"liberadas e negadas ao mesmo tempo: {sorted(clashes)}")

    # --- Instalação ---

    def test_install_runs_only_after_the_checksum(self):
        commands = self.apply_commands()
        check = next(i for i, c in enumerate(commands) if "sha256sum --check --strict" in c)
        download = next(i for i, c in enumerate(commands) if c.startswith("curl "))
        extract = next(i for i, c in enumerate(commands) if c.startswith("tar "))
        run = next(i for i, c in enumerate(commands) if "install-node.sh" in c)
        self.assertLess(download, check)
        self.assertLess(check, extract)
        self.assertLess(extract, run)
        self.assertEqual(commands[0], "set -euo pipefail")
        self.assertIn("--proto '=https'", commands[download])
        self.assertIn("https://github.com/williandotdev/verax-control/releases/download/node-v", "\n".join(commands))

    def test_document_parameters_are_validated(self):
        parameters = self.resources["ApplyDocument"]["Properties"]["Content"]["parameters"]
        valid = {
            "Version": "1.2.3",
            "Sha256": "a" * 64,
            "NodeId": "verax-control-node-cliente",
            "DataVolumeId": "vol-0123456789abcdef0",
            "BackupBucket": "verax-control-node-backupbucket-abc123",
        }
        self.assertEqual(set(parameters), set(valid))
        # Os valores entram no shell entre aspas simples: nenhum caractere que saia delas ou quebre a linha passa
        # (validação da string inteira; a quebra de linha no fim é barrada de novo no shell, teste abaixo).
        for name, spec in parameters.items():
            with self.subTest(parameter=name):
                pattern = re.compile(spec["allowedPattern"])
                self.assertTrue(pattern.fullmatch(valid[name]))
                for char in ["'", '"', ";", "$", "`", "\\", " ", "\n", "|", "&", "(", ")"]:
                    self.assertFalse(pattern.fullmatch(valid[name] + char), repr(char))
                    self.assertFalse(pattern.fullmatch(char + valid[name]), repr(char))
        self.assertFalse(re.compile(parameters["Version"]["allowedPattern"]).fullmatch("1.2"))
        self.assertFalse(re.compile(parameters["Sha256"]["allowedPattern"]).fullmatch("a" * 63))

    def test_shell_validates_the_parameters_again(self):
        # Em vários motores de regex o $ aceita uma quebra de linha no fim; no [[ =~ ]] do bash, não. A conferência
        # do shell vem antes de qualquer uso e cobre todos os parâmetros, com os mesmos padrões do documento.
        commands = self.apply_commands()
        parameters = self.resources["ApplyDocument"]["Properties"]["Content"]["parameters"]
        guard = next(i for i, c in enumerate(commands) if c.startswith("if ! [["))
        variables = {
            "Version": "version",
            "Sha256": "sha256",
            "NodeId": "node_id",
            "DataVolumeId": "volume_id",
            "BackupBucket": "bucket",
        }
        for name, variable in variables.items():
            with self.subTest(parameter=name):
                self.assertIn(f"{variable}='{{{{{name}}}}}'", commands[:guard])
                self.assertIn(f"${variable} =~ {parameters[name]['allowedPattern']}", commands[guard])
        self.assertTrue(commands[guard].endswith("then echo 'parâmetros fora do formato' >&2; exit 1; fi"))
        # Depois da conferência, só as variáveis conferidas: nenhum {{parâmetro}} direto no shell.
        self.assertNotIn("{{", "\n".join(commands[guard + 1 :]))

    def test_install_only_with_version_and_checksum(self):
        association = self.resources["ApplyAssociation"]
        self.assertEqual(association["Condition"], "HasBundle")
        rule = self.template["Rules"]["VersaoComChecksum"]
        self.assertEqual(rule["RuleCondition"], {"Fn::Not": [{"Fn::Equals": [{"Ref": "BundleVersion"}, ""]}]})
        self.assertEqual(
            rule["Assertions"][0]["Assert"], {"Fn::Not": [{"Fn::Equals": [{"Ref": "BundleSha256"}, ""]}]}
        )
        self.assertEqual(association["Properties"]["Targets"], [{"Key": "InstanceIds", "Values": [{"Ref": "Instance"}]}])

    # --- Alertas ---

    def test_hardware_failure_recovers_and_alerts(self):
        actions = self.resources["RecoverAlarm"]["Properties"]["AlarmActions"]
        self.assertIn({"Fn::Sub": "arn:${AWS::Partition}:automate:${AWS::Region}:ec2:recover"}, actions)
        self.assertIn({"Ref": "AlertTopic"}, actions)
        self.assertIn({"Ref": "AlertTopic"}, self.resources["DataDiskAlarm"]["Properties"]["AlarmActions"])

    def test_budget_counts_only_the_node(self):
        budget = self.resources["Budget"]
        self.assertEqual(budget["Condition"], "HasBudget")
        tag = budget["Properties"]["Budget"]["CostFilters"]["TagKeyValue"][0]["Fn::Sub"][0]
        self.assertEqual(tag, "user:verax-control-node$${Id}")


if __name__ == "__main__":
    unittest.main()
