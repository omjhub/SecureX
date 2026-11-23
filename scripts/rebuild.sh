#!/usr/bin/env bash
# Rebuild the SecureX platform (qa and prod namespaces) on a fresh EKS cluster.
# Run from your Mac. Takes about 30 minutes, mostly waiting for AWS.
set -euo pipefail

# Docker Hub pull credentials for the private image (never hard-code these):
#   export DOCKERHUB_USERNAME=omajuwa
#   export DOCKERHUB_TOKEN=<a Docker Hub access token with read-only scope>
: "${DOCKERHUB_USERNAME:?Set DOCKERHUB_USERNAME first}"
: "${DOCKERHUB_TOKEN:?Set DOCKERHUB_TOKEN first}"

export AWS_REGION=eu-north-1
export CLUSTER_NAME=securex-cluster
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "Account: $ACCOUNT_ID  Region: $AWS_REGION  Cluster: $CLUSTER_NAME"

echo "== 1/8 Creating the cluster (about 15 to 20 minutes)"
eksctl create cluster --name "$CLUSTER_NAME" --region "$AWS_REGION" \
  --nodegroup-name securex-nodes --node-type m7i-flex.large \
  --nodes 3 --nodes-min 3 --nodes-max 4 --managed
eksctl utils associate-iam-oidc-provider --cluster "$CLUSTER_NAME" --region "$AWS_REGION" --approve
export VPC_ID=$(aws eks describe-cluster --name "$CLUSTER_NAME" --region "$AWS_REGION" \
  --query "cluster.resourcesVpcConfig.vpcId" --output text)
for NS in qa prod; do
  kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f -
done

echo "== 2/8 GitHub Actions access (one role per namespace)"
for PAIR in qa:GitHubActionsEKSDeployRoleQA prod:GitHubActionsEKSDeployRolePROD; do
  NS=${PAIR%%:*}; ROLE=${PAIR##*:}
  ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE}"
  aws eks create-access-entry --cluster-name "$CLUSTER_NAME" --region "$AWS_REGION" \
    --principal-arn "$ROLE_ARN" || true
  aws eks associate-access-policy --cluster-name "$CLUSTER_NAME" --region "$AWS_REGION" \
    --principal-arn "$ROLE_ARN" \
    --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSEditPolicy \
    --access-scope type=namespace,namespaces="$NS"
done

echo "== 3/8 AWS Load Balancer Controller"
eksctl create iamserviceaccount --cluster "$CLUSTER_NAME" --region "$AWS_REGION" \
  --namespace kube-system --name aws-load-balancer-controller \
  --attach-policy-arn "arn:aws:iam::${ACCOUNT_ID}:policy/AWSLoadBalancerControllerIAMPolicy" \
  --override-existing-serviceaccounts --approve
helm repo add eks https://aws.github.io/eks-charts >/dev/null 2>&1 || true
helm repo update eks
helm upgrade --install aws-load-balancer-controller eks/aws-load-balancer-controller -n kube-system \
  --set clusterName="$CLUSTER_NAME" --set serviceAccount.create=false \
  --set serviceAccount.name=aws-load-balancer-controller \
  --set region="$AWS_REGION" --set vpcId="$VPC_ID" --version 1.14.0 --wait

echo "== 4/8 EBS CSI driver"
eksctl create iamserviceaccount --cluster "$CLUSTER_NAME" --region "$AWS_REGION" \
  --namespace kube-system --name ebs-csi-controller-sa \
  --role-name AmazonEKS_EBS_CSI_DriverRole --role-only \
  --attach-policy-arn arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy --approve
aws eks create-addon --cluster-name "$CLUSTER_NAME" --region "$AWS_REGION" \
  --addon-name aws-ebs-csi-driver \
  --service-account-role-arn "arn:aws:iam::${ACCOUNT_ID}:role/AmazonEKS_EBS_CSI_DriverRole" \
  --resolve-conflicts OVERWRITE
aws eks wait addon-active --cluster-name "$CLUSTER_NAME" --region "$AWS_REGION" --addon-name aws-ebs-csi-driver

echo "== 5/8 EBS StorageClass"
kubectl apply -f - <<'YAML'
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ebs-sc
provisioner: ebs.csi.aws.com
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
parameters:
  type: gp3
  fsType: ext4
YAML

echo "== 6/8 External Secrets Operator"
helm repo add external-secrets https://charts.external-secrets.io >/dev/null 2>&1 || true
helm repo update external-secrets
helm upgrade --install external-secrets external-secrets/external-secrets \
  -n external-secrets --create-namespace --wait

echo "== 7/8 Per-namespace secrets: regcred, ESO service account, SecretStore, ExternalSecret"
for NS in qa prod; do
  NS_UPPER=$(echo "$NS" | tr '[:lower:]' '[:upper:]')

  kubectl create secret docker-registry regcred -n "$NS" \
    --docker-server=https://index.docker.io/v1/ \
    --docker-username="$DOCKERHUB_USERNAME" --docker-password="$DOCKERHUB_TOKEN" \
    --dry-run=client -o yaml | kubectl apply -f -

  ESO_POLICY_ARN=$(aws iam list-policies --scope Local \
    --query "Policies[?PolicyName=='ESOSecretsManager${NS_UPPER}ReadPolicy'].Arn" --output text)
  eksctl create iamserviceaccount --cluster "$CLUSTER_NAME" --region "$AWS_REGION" \
    --namespace "$NS" --name "eso-${NS}-sa" --role-name "eso-${NS}-secrets-role" \
    --attach-policy-arn "$ESO_POLICY_ARN" --override-existing-serviceaccounts --approve

  kubectl apply -f - <<YAML
apiVersion: external-secrets.io/v1
kind: SecretStore
metadata:
  name: aws-secretsmanager
  namespace: ${NS}
spec:
  provider:
    aws:
      service: SecretsManager
      region: ${AWS_REGION}
      auth:
        jwt:
          serviceAccountRef:
            name: eso-${NS}-sa
---
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: mysql-external-secret
  namespace: ${NS}
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secretsmanager
    kind: SecretStore
  target:
    name: mysql-secret
    creationPolicy: Owner
  dataFrom:
    - extract:
        key: ${NS}/mysql-secret
YAML

  echo "Waiting for mysql-secret in ${NS}..."
  for i in $(seq 1 30); do
    kubectl get secret mysql-secret -n "$NS" >/dev/null 2>&1 && { echo "mysql-secret ready in ${NS}."; break; }
    sleep 5
  done
done

echo "== 8/8 Done"
cat <<MSG
Next steps:
  1. Deploy QA: push a commit to the qa branch, or re-run the QA workflow in GitHub.
  2. Deploy prod: merge qa into main, or run "Production CD Pipeline" from the Actions tab.
  3. Both Ingresses share one ALB (group securex). Get its address:
       kubectl get ingress -n qa
  4. In Route 53, point omajuwa.space and qa.omajuwa.space (Alias A records) at that ALB.
  5. Open https://omajuwa.space (prod) and https://qa.omajuwa.space (QA).
MSG
