cd ..
echo "Building docker images..."
docker compose build
cd k8s
echo "Creating namespace..."
kubectl apply -f space-namespace.yml
echo "Deploying ingress controller..."
kubectl apply -f controllers/
echo "Creating the pricing token signing key (only if it does not exist yet)..."
if ! kubectl -n space get secret space-pricing-token-key >/dev/null 2>&1; then
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 \
    | kubectl -n space create secret generic space-pricing-token-key --from-file=private.pem=/dev/stdin
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