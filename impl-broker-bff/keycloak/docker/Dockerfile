FROM quay.io/keycloak/keycloak:26.8.2

# `vault` is a build-time option. Building it into the image avoids slow or
# inconsistent optimized startup on every container restart.
RUN /opt/keycloak/bin/kc.sh build --vault=file
