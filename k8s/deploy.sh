#!/bin/sh
set -eu

deploy_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
pricing_key_file=''
cleanup() {
  if [ -n "$pricing_key_file" ]; then
    rm -f -- "$pricing_key_file"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cd "$deploy_dir/.."
echo "Building docker images..."
docker compose build
cd "$deploy_dir"
echo "Creating namespace..."
kubectl apply -f space-namespace.yml
echo "Deploying ingress controller..."
kubectl apply -f controllers/
echo "Creating the pricing token signing key (only if it does not exist yet)..."
if ! pricing_key_secret=$(kubectl -n space get secret space-pricing-token-key --ignore-not-found -o name); then
  echo "Cannot check the pricing token signing secret; deployment stopped." >&2
  exit 1
fi
if [ -z "$pricing_key_secret" ]; then
  umask 077
  pricing_key_file=$(mktemp "${TMPDIR:-/tmp}/space-pricing-token-key.XXXXXX")
  # Complete and validate generation before creating a persistent secret.
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$pricing_key_file"
  openssl pkey -in "$pricing_key_file" -check -noout >/dev/null
  kubectl -n space create secret generic space-pricing-token-key --from-file="private.pem=$pricing_key_file"
  rm -f -- "$pricing_key_file"
  pricing_key_file=''
fi
echo "Deploying config maps..."
kubectl apply -f config/
echo "Deploying services..."
kubectl apply -f pods/
echo "Deploying ingress rules..."
kubectl apply -f load-balancer/

# k8s_dashboard_deploy:
# 	@echo "Accessing k8s dashboard"
# 	@kubectl apply -f dashboard/

# k8s_dashboard_undeploy:
# 	@echo "Undeploying k8s dashboard"
# 	@kubectl delete -f dashboard/

# k8s_deploy_all: k8s_deploy k8s_dashboard_deploy

# k8s_undeploy_all: k8s_undeploy k8s_dashboard_undeploy

# k8s_dashboard:
# 	@echo "Accessing k8s dashboard"
# 	@kubectl proxy
# 	@echo "http://localhost:8001/api/v1/namespaces/kube-system/services/https:kubernetes-dashboard:/proxy/"

# k8s_create_token:
# 	@echo "Getting k8s token"
# 	@kubectl -n kubernetes-dashboard create token admin-user
