#!/bin/sh
# Sets OnicaiBot up on OpenChat's EC2 host, before its first deploy, for someone with OpenChat's AWS
# access: aws/setup.sh. Each step is skipped once it's done, but the last two install the restart
# document and the host's unit and start script as they are in this folder, so run it again after
# changing any of them, as the deploy workflow can't. A changed start script or unit takes effect at
# the next deploy.
set -eu
export AWS_REGION=us-east-1
INSTANCE=i-0198f9d466e519454
DEPLOY_ROLE=GitHubActions-DeployOnicaiBot
# Without quotes, as it's matched in a query
COMMENT="OnicaiBot: onicai games played from MiniApp cards"
cd "$(dirname "$0")"

exists() { "$@" > /dev/null 2>&1; }

# A parameter's value goes through a file, as a key starts with dashes, which the CLI takes for an
# option, and doesn't belong on a command line
put() {
    file=$(mktemp)
    printf '%s' "$3" > "$file"
    aws ssm put-parameter --name "/oc-onicai-bot/$1" --type "$2" --value "file://$file" --overwrite > /dev/null
    rm -f "$file"
}

# Runs a script on the host as root, and prints its output once it's done
on_host() {
    id=$(aws ssm send-command --instance-ids "$INSTANCE" --document-name AWS-RunShellScript \
        --timeout-seconds 60 --comment "$1" \
        --parameters "$(jq -n --arg script "$2" '{commands: [$script]}')" \
        --query Command.CommandId --output text)
    for _ in $(seq 60); do
        sleep 5
        status=$(aws ssm get-command-invocation --command-id "$id" --instance-id "$INSTANCE" --query Status --output text 2> /dev/null) || status=Pending
        case "$status" in Pending | InProgress | Delayed) ;; *) break ;; esac
    done
    aws ssm get-command-invocation --command-id "$id" --instance-id "$INSTANCE" \
        --query '[StandardOutputContent, StandardErrorContent]' --output text
    [ "$status" = Success ]
}

echo "ECR repository oc-onicai-bot"
exists aws ecr describe-repositories --repository-names oc-onicai-bot ||
    aws ecr create-repository --repository-name oc-onicai-bot > /dev/null

echo "Log group /oc/onicai-bot, kept 30 days"
[ "$(aws logs describe-log-groups --log-group-name-prefix /oc/onicai-bot --query 'length(logGroups)' --output text)" != 0 ] ||
    aws logs create-log-group --log-group-name /oc/onicai-bot
aws logs put-retention-policy --log-group-name /oc/onicai-bot --retention-in-days 30

echo "Config in /oc-onicai-bot/: a new identity, and OpenChat's key and MiniApp service as MiniGameBot has them"
exists aws ssm get-parameter --name /oc-onicai-bot/IDENTITY_PRIVATE ||
    put IDENTITY_PRIVATE SecureString "$(openssl ecparam -name secp256k1 -genkey -noout)"
for name in OC_PUBLIC MINI_APP_SERVICE_URL; do
    exists aws ssm get-parameter --name "/oc-onicai-bot/$name" ||
        put "$name" String "$(aws ssm get-parameter --name "/oc-minigame-bot/$name" --query Parameter.Value --output text)"
done

echo "The host's role: reading the config, pulling the image and writing the logs"
aws iam put-role-policy --role-name oc-discord-bridge --policy-name oc-onicai-bot \
    --policy-document file://instance-role-policy.json

# A second rule with CloudFront's prefix list is over the group's limit, so the one rule's ports are
# widened, and never narrowed, as later services may have widened them further
echo "The host's security group: 8085 from CloudFront"
to=$(aws ec2 describe-security-group-rules --security-group-rule-ids sgr-00f8bcacba0e7ed49 --query 'SecurityGroupRules[0].ToPort' --output text)
if [ "$to" -lt 8085 ]; then
    aws ec2 modify-security-group-rules --group-id sg-01f3671836db36116 --security-group-rules "$(jq -n '[{
        SecurityGroupRuleId: "sgr-00f8bcacba0e7ed49",
        SecurityGroupRule: {
            IpProtocol: "tcp", FromPort: 8080, ToPort: 8085, PrefixListId: "pl-3b927c52",
            Description: "CloudFront, to the Discord (8080) and Twitch (8081) bridges, the price service (8082), the MiniApp service (8083), MiniGameBot (8084) and OnicaiBot (8085)"
        }
    }]')" > /dev/null
fi

# As MiniGameBot's: HTTP to the host's 8085, HTTPS only to viewers, every method, nothing cached,
# and the viewer's headers but Host passed on
echo "Public URL: a CloudFront distribution in front of the host's 8085"
domain=$(aws cloudfront list-distributions --query "DistributionList.Items[?Comment=='$COMMENT'].DomainName | [0]" --output text)
if [ "$domain" = None ]; then
    origin=$(aws ec2 describe-instances --instance-ids "$INSTANCE" --query 'Reservations[0].Instances[0].PublicDnsName' --output text)
    domain=$(aws cloudfront create-distribution --query Distribution.DomainName --output text --distribution-config "$(
        jq -n --arg ref "oc-onicai-bot-$(date +%s)" --arg comment "$COMMENT" --arg origin "$origin" '{
            CallerReference: $ref, Comment: $comment, Enabled: true,
            PriceClass: "PriceClass_100", HttpVersion: "http2and3", IsIPV6Enabled: true,
            Origins: {Quantity: 1, Items: [{
                Id: "bot", DomainName: $origin,
                CustomOriginConfig: {
                    HTTPPort: 8085, HTTPSPort: 443, OriginProtocolPolicy: "http-only",
                    OriginSslProtocols: {Quantity: 1, Items: ["TLSv1.2"]},
                    OriginReadTimeout: 60, OriginKeepaliveTimeout: 5
                }
            }]},
            DefaultCacheBehavior: {
                TargetOriginId: "bot", ViewerProtocolPolicy: "https-only", Compress: false,
                CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
                OriginRequestPolicyId: "b689b0a8-53d0-40ab-baf2-68738e2966ac",
                AllowedMethods: {
                    Quantity: 7, Items: ["HEAD", "DELETE", "POST", "GET", "OPTIONS", "PUT", "PATCH"],
                    CachedMethods: {Quantity: 2, Items: ["HEAD", "GET"]}
                }
            }
        }'
    )")
fi
put PUBLIC_URL String "https://$domain"

echo "The deploy role, $DEPLOY_ROLE, for this repo's main"
if exists aws iam get-role --role-name "$DEPLOY_ROLE"; then
    aws iam update-assume-role-policy --role-name "$DEPLOY_ROLE" --policy-document file://deploy-role-trust.json
else
    aws iam create-role --role-name "$DEPLOY_ROLE" --assume-role-policy-document file://deploy-role-trust.json \
        --description "Deploys OnicaiBot from kanodia/onicaibotoc's main" > /dev/null
fi
aws iam put-role-policy --role-name "$DEPLOY_ROLE" --policy-name deploy --policy-document file://deploy-role-policy.json

echo "The restart document, oc-onicai-bot-restart"
if exists aws ssm describe-document --name oc-onicai-bot-restart; then
    # An unchanged document is refused as a duplicate, and stays as it is
    if version=$(aws ssm update-document --name oc-onicai-bot-restart --document-format YAML \
        --content file://oc-onicai-bot-restart.yaml --document-version '$LATEST' \
        --query DocumentDescription.DocumentVersion --output text 2>&1); then
        aws ssm update-document-default-version --name oc-onicai-bot-restart --document-version "$version" > /dev/null
    else
        case "$version" in *DuplicateDocumentContent*) ;; *) echo "$version" >&2 && exit 1 ;; esac
    fi
else
    aws ssm create-document --name oc-onicai-bot-restart --document-type Command --document-format YAML \
        --content file://oc-onicai-bot-restart.yaml > /dev/null
fi

# Enabled but not started: the first deploy starts it, once there's an image to pull. Written as
# base64, so their quotes and newlines arrive as they are.
echo "The host's start script and unit"
start=$(base64 < oc-onicai-bot-start | tr -d '\n')
unit=$(base64 < oc-onicai-bot.service | tr -d '\n')
on_host "Install OnicaiBot's start script and unit" "set -eu
echo $start | base64 -d > /usr/local/bin/oc-onicai-bot-start.new
chmod 755 /usr/local/bin/oc-onicai-bot-start.new
mv /usr/local/bin/oc-onicai-bot-start.new /usr/local/bin/oc-onicai-bot-start
echo $unit | base64 -d > /etc/systemd/system/oc-onicai-bot.service
systemctl daemon-reload
systemctl enable -q oc-onicai-bot
echo Installed"

echo "Done. The bot will be served at https://$domain once the deploy workflow has run."
