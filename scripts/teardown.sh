#!/usr/bin/env bash
# Tear down the SecureX platform (QA, prod, monitoring) at the end of the day.
# Keeps: Secrets Manager secrets, ACM certificate, IAM policies, GitHub OIDC roles,
#        the Loki S3 bucket (logs expire after 35 days) and LokiS3Policy.
set -uo pipefail

AWS_REGION=eu-north-1
CLUSTER_NAME=securex-cluster
NODEGROUP_NAME=securex-nodes

step() { echo; echo "== $*"; }

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

step "1/6 Deleting every Ingress in the cluster (removes app and Grafana ALBs)"
kubectl delete ingress --all --all-namespaces --ignore-not-found
echo "Waiting for the ALBs to be removed..."
for i in $(seq 1 36); do
  LBS=$(aws elbv2 describe-load-balancers --region "$AWS_REGION" \
        --query "LoadBalancers[?starts_with(LoadBalancerName,'k8s-')].LoadBalancerName" --output text)
  [ -z "$LBS" ] && { echo "All ALBs removed."; break; }
  sleep 10
done
[ -n "${LBS:-}" ] && echo "WARNING: still present: $LBS (check EC2 > Load Balancers)"

step "2/6 Removing the monitoring stack"
helm uninstall grafana    -n monitoring 2>/dev/null || true
helm uninstall alloy      -n monitoring 2>/dev/null || true
helm uninstall loki       -n monitoring 2>/dev/null || true
helm uninstall monitoring -n monitoring 2>/dev/null || true

step "3/6 Deleting databases and all persistent volumes (QA and prod data are not kept)"
kubectl delete statefulset --all -n qa   --ignore-not-found
kubectl delete statefulset --all -n prod --ignore-not-found
kubectl delete pvc --all --all-namespaces --ignore-not-found --wait=true
echo "Waiting for EBS volumes to be released..."
sleep 30

step "4/6 Detaching LokiS3Policy from the node role (otherwise the role cannot be deleted)"
NODE_ROLE_ARN=$(aws eks describe-nodegroup --cluster-name "$CLUSTER_NAME" --nodegroup-name "$NODEGROUP_NAME" \
  --region "$AWS_REGION" --query "nodegroup.nodeRole" --output text 2>/dev/null || true)
if [ -n "$NODE_ROLE_ARN" ] && [ "$NODE_ROLE_ARN" != "None" ]; then
  aws iam detach-role-policy --role-name "${NODE_ROLE_ARN##*/}" \
    --policy-arn "arn:aws:iam::${ACCOUNT_ID}:policy/LokiS3Policy" 2>/dev/null \
    && echo "Detached from ${NODE_ROLE_ARN##*/}" || echo "Not attached, nothing to do"
fi

step "5/6 Deleting the cluster (about 10 to 15 minutes)"
eksctl delete cluster --name "$CLUSTER_NAME" --region "$AWS_REGION" --wait

step "6/6 Checking for anything left that still costs money"
echo "Load balancers:"
aws elbv2 describe-load-balancers --region "$AWS_REGION" --query "LoadBalancers[].LoadBalancerName" --output text
echo "Unattached EBS volumes:"
aws ec2 describe-volumes --region "$AWS_REGION" --filters Name=status,Values=available \
  --query "Volumes[].[VolumeId,Size]" --output text
echo "EKS clusters:"
aws eks list-clusters --region "$AWS_REGION" --query "clusters" --output text
echo
echo "Done. All three lists above should be empty."
echo "Leftover volumes can be removed with: aws ec2 delete-volume --volume-id <id> --region $AWS_REGION"
